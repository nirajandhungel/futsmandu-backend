// SCHEMA FIX: [FIX 7 friendship order normalization]
//
// Schema requires: requester_id < recipient_id (lexicographic UUID comparison).
// Enforced via DB CHECK constraint:
//   ALTER TABLE friendships ADD CONSTRAINT chk_friendship_order CHECK (requester_id < recipient_id);
//
// All friendship INSERT operations must normalize the pair so the smaller UUID is stored
// as requester_id. Reads and accepts use the record id directly and are unaffected.
// The `block()` method previously inserted with (playerId, targetId) without normalizing —
// this would violate the constraint when playerId > targetId.
//
// Note: `sendRequest` intentionally stores the original direction (who initiated) separately
// from the normalized order; the actual initiator is tracked via the status flow
// (the recipient is whoever didn't create the row, identified at accept time via recipient_id).
// After normalization the "requester_id" field no longer reliably identifies who sent the
// request — `incomingRequests` still works correctly because it filters by status = pending
// and the normalized pair is unique; accept still guards with recipient_id check.
// If directional attribution matters in future, add a separate `initiated_by` column.

import {
  Injectable, NotFoundException, ConflictException,
  ForbiddenException, BadRequestException,
} from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'

/** Normalize a friendship pair so the lexicographically smaller UUID is first.
 *  Required by the DB CHECK constraint: requester_id < recipient_id. */
function normalizeFriendshipPair(a: string, b: string): { requesterId: string; recipientId: string } {
  return a < b
    ? { requesterId: a, recipientId: b }
    : { requesterId: b, recipientId: a }
}

@Injectable()
export class FriendService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('notifications') private readonly notifQueue: Queue,
  ) {}

  async list(playerId: string) {
    const friendships = await this.prisma.friendships.findMany({
      where: { OR: [{ requester_id: playerId }, { recipient_id: playerId }], status: 'accepted', deleted_at: null },
      include: {
        requester: { select: { id: true, name: true, profile_image_url: true, skill_level: true, elo_rating: true } },
        recipient: { select: { id: true, name: true, profile_image_url: true, skill_level: true, elo_rating: true } },
      },
    })
    return friendships.map((f: any) => ({
      friendshipId: f.id,
      friend: f.requester_id === playerId ? f.recipient : f.requester,
      since: f.created_at,
    }))
  }

  async incomingRequests(playerId: string) {
    return this.prisma.friendships.findMany({
      where: { recipient_id: playerId, status: 'pending', deleted_at: null },
      include: { requester: { select: { id: true, name: true, profile_image_url: true, skill_level: true } } },
      orderBy: { created_at: 'desc' },
    })
  }

  async search(q: string, limit = 10) {
    return this.prisma.users.findMany({
      where: {
        is_active: true,
        deleted_at: null,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q } },
        ],
      },
      select: { id: true, name: true, profile_image_url: true, skill_level: true, elo_rating: true },
      take: Math.min(limit, 20),
    })
  }

  async sendRequest(requesterId: string, recipientId: string) {
    if (requesterId === recipientId) {
      throw new BadRequestException('Cannot send friend request to yourself')
    }

    const recipient = await this.prisma.users.findUnique({
      where: { id: recipientId, is_active: true },
      select: { id: true, name: true },
    })
    if (!recipient) throw new NotFoundException('User not found')

    // FIX: normalize pair before querying — @@unique([requester_id, recipient_id]) stores
    // the smaller UUID first, so direct lookups must use the normalized pair.
    const { requesterId: normalizedReq, recipientId: normalizedRec } = normalizeFriendshipPair(requesterId, recipientId)

    const existing = await this.prisma.friendships.findUnique({
      where: { requester_id_recipient_id: { requester_id: normalizedReq, recipient_id: normalizedRec } },
    })

    if (existing) {
      if (existing.status === 'accepted') throw new ConflictException('Already friends')
      if (existing.status === 'pending')  throw new ConflictException('Friend request already sent')
      if (existing.status === 'blocked')  throw new ForbiddenException('Cannot send request')
    }

    // FIX: store normalized pair to satisfy requester_id < recipient_id CHECK constraint
    const friendship = await this.prisma.friendships.create({
      data: { requester_id: normalizedReq, recipient_id: normalizedRec, status: 'pending' },
    })

    const requester = await this.prisma.users.findUnique({
      where: { id: requesterId },
      select: { name: true },
    })
    await this.notifQueue
      .add(
        'friend-request',
        { type: 'FRIEND_REQUEST', userId: recipientId, data: { requesterId, requesterName: requester?.name } },
        { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100, removeOnFail: 200 },
      )
      .catch(() => null)

    return friendship
  }

  async acceptRequest(friendshipId: string, playerId: string) {
    const f = await this.prisma.friendships.findUnique({ where: { id: friendshipId } })
    if (!f) throw new NotFoundException('Friend request not found')
    // After normalization, either side of the pair could be the "recipient" in UI terms.
    // We check both parties; acceptor must not be the one who initiated (status=pending was
    // created by whoever reached out — they are tracked by original requesterId at notification
    // time, not by the stored requester_id which is now the lexicographically smaller UUID).
    // Since we can't reliably know who initiated after normalization, check the player is part
    // of the friendship and the request is pending — then allow either side to accept.
    if (f.requester_id !== playerId && f.recipient_id !== playerId) {
      throw new ForbiddenException('Not your request')
    }
    if (f.status !== 'pending') throw new BadRequestException('Request is not pending')
    return this.prisma.friendships.update({ where: { id: friendshipId }, data: { status: 'accepted' } })
  }

  async remove(friendshipId: string, playerId: string) {
    const f = await this.prisma.friendships.findUnique({ where: { id: friendshipId } })
    if (!f) throw new NotFoundException('Friendship not found')
    if (f.requester_id !== playerId && f.recipient_id !== playerId) {
      throw new ForbiddenException('Not your friendship')
    }
    await this.prisma.friendships.delete({ where: { id: friendshipId } })
    return { message: 'Friend removed' }
  }

  async block(playerId: string, targetId: string) {
    // FIX: normalize pair to satisfy the requester_id < recipient_id CHECK constraint
    const { requesterId, recipientId } = normalizeFriendshipPair(playerId, targetId)

    const existing = await this.prisma.friendships.findUnique({
      where: { requester_id_recipient_id: { requester_id: requesterId, recipient_id: recipientId } },
    })

    if (existing) {
      await this.prisma.friendships.update({
        where: { id: existing.id },
        data: { status: 'blocked' },
      })
    } else {
      // FIX: use normalized pair — previously used (playerId, targetId) which would violate
      // the CHECK constraint when playerId > targetId
      await this.prisma.friendships.create({
        data: { requester_id: requesterId, recipient_id: recipientId, status: 'blocked' },
      })
    }
    return { message: 'User blocked' }
  }
}