// apps/player-api/src/modules/friend/friend.service.ts
// Friend graph — bidirectional friendships with spam prevention.
// Rate limiting (20 requests/day) applied at controller level via ThrottlerGuard.

import {
  Injectable, NotFoundException, ConflictException,
  ForbiddenException, BadRequestException,
} from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { PrismaService } from '@futsmandu/database'

@Injectable()
export class FriendService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('notifications') private readonly notifQueue: Queue,
  ) {}

  async list(playerId: string) {
    const friendships = await this.prisma.friendships.findMany({
      where: { OR: [{ requester_id: playerId }, { recipient_id: playerId }], status: 'accepted' },
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
      where: { recipient_id: playerId, status: 'pending' },
      include: { requester: { select: { id: true, name: true, profile_image_url: true, skill_level: true } } },
      orderBy: { created_at: 'desc' },
    })
  }

  async search(q: string, limit = 10) {
    return this.prisma.users.findMany({
      where: {
        is_active: true,
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

    const existing = await this.prisma.friendships.findFirst({
      where: {
        OR: [
          { requester_id: requesterId, recipient_id: recipientId },
          { requester_id: recipientId, recipient_id: requesterId },
        ],
      },
    })

    if (existing) {
      if (existing.status === 'accepted') throw new ConflictException('Already friends')
      if (existing.status === 'pending')  throw new ConflictException('Friend request already sent')
      if (existing.status === 'blocked')  throw new ForbiddenException('Cannot send request')
    }

    const friendship = await this.prisma.friendships.create({
      data: { requester_id: requesterId, recipient_id: recipientId, status: 'pending' },
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
    if (f.recipient_id !== playerId) throw new ForbiddenException('Not your request')
    if (f.status !== 'pending')      throw new BadRequestException('Request is not pending')
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
    const existing = await this.prisma.friendships.findFirst({
      where: {
        OR: [
          { requester_id: playerId, recipient_id: targetId },
          { requester_id: targetId, recipient_id: playerId },
        ],
      },
    })

    if (existing) {
      await this.prisma.friendships.update({
        where: { id: existing.id },
        data: { status: 'blocked' },
      })
    } else {
      await this.prisma.friendships.create({
        data: { requester_id: playerId, recipient_id: targetId, status: 'blocked' },
      })
    }
    return { message: 'User blocked' }
  }
}
