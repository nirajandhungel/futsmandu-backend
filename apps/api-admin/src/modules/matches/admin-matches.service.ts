import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@futsmandu/database';
import { ListMatchesQueryDto } from './dto/match.dto.js';

@Injectable()
export class AdminMatchesService {
  constructor(private readonly prisma: PrismaService) {}

  async listMatches(query: ListMatchesQueryDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.matches.findMany({
        skip,
        take: limit,
        include: {
          booking: {
            select: {
              id: true,
              booking_name: true,
              booking_date: true,
              start_time: true,
              venue: { select: { name: true } },
            },
          },
          _count: { select: { members: true } },
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.matches.count(),
    ]);

    return {
      items: items.map((m: any) => ({
        id: m.id,
        booking_id: m.booking_id,
        status: m.status,
        max_players: m.max_players,
        current_players: m._count.members,
        venue_name: m.booking?.venue?.name || 'Unknown',
        date: m.booking?.booking_date,
        time: m.booking?.start_time,
        winner: m.winner,
      })),
      page,
      totalPages: Math.ceil(total / limit),
      totalItems: total,
    };
  }

  async getMatchDetail(id: string) {
    const match = await this.prisma.matches.findUnique({
      where: { id },
      include: {
        booking: {
          include: {
            venue: true,
          }
        },
        members: {
          include: {
            player: true
          }
        }
      }
    });

    if (!match) throw new NotFoundException('Match not found');

    return match;
  }
}
