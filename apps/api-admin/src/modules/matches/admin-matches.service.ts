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
      this.prisma.match_groups.findMany({
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
      this.prisma.match_groups.count(),
    ]);

    return {
      items: items.map((m: any) => ({
        id: m.id,
        booking_id: m.booking_id,
        status: m.fill_status, // match_groups uses fill_status
        max_players: m.max_players,
        current_players: m._count.members,
        venue_name: m.booking?.venue?.name || 'Unknown',
        date: m.match_date || m.booking?.booking_date,
        time: m.start_time || m.booking?.start_time,
        winner: m.result_winner, // match_groups uses result_winner
      })),
      page,
      totalPages: Math.ceil(total / limit),
      totalItems: total,
    };
  }

  async getMatchDetail(id: string) {
    const match = await this.prisma.match_groups.findUnique({
      where: { id },
      include: {
        booking: {
          include: {
            venue: true,
          }
        },
        members: {
          include: {
            user: {
                select: {
                    id: true,
                    name: true,
                    elo_rating: true
                }
            }
          }
        }
      }
    });

    if (!match) throw new NotFoundException('Match not found');

    return {
      id: match.id,
      booking_id: match.booking_id,
      status: match.fill_status,
      max_players: match.max_players,
      current_players: match.members.length,
      venue_name: match.booking?.venue?.name || 'Unknown',
      date: match.match_date || match.booking?.booking_date,
      time: match.start_time || match.booking?.start_time,
      winner: match.result_winner,
      invite_token: match.invite_token,
      team_a: match.team_a || [],
      team_b: match.team_b || [],
      players: match.members.map((m: any) => ({
        id: m.user.id,
        name: m.user.name,
        elo_rating: m.user.elo_rating
      })),
      raw: match // Keep raw data if needed
    };
  }
}
