// apps/player-api/src/workers/processors/stats.processor.ts
// FIX: Extracted from refund.processor.ts where it lived with aliased NestJS decorators.
// Aliased decorator imports (@Processor as StatsProc) are fragile and can cause NestJS
// to silently mis-register processors. Each processor must be its own file.

import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger, Inject } from '@nestjs/common'
import { Job } from 'bullmq'
import type { StatsJobData } from '@futsmandu/types'
import { PrismaService } from '@futsmandu/database'

@Processor('player-stats')
export class StatsProcessor extends WorkerHost {
  private readonly logger = new Logger(StatsProcessor.name)
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super()
  }

  async process(job: Job<StatsJobData>): Promise<void> {
    if (job.name !== 'update-elo') return
    const { matchGroupId, winner } = job.data
    const members = await this.prisma.match_group_members.findMany({
      where: { match_group_id: matchGroupId, status: 'confirmed' },
      select: { user_id: true, team_side: true },
    })
    for (const m of members) {
      const won  = m.team_side === winner
      const draw = winner === 'draw'
      await this.prisma.users.update({
        where: { id: m.user_id },
        data: {
          matches_played: { increment: 1 },
          ...(draw ? { matches_draw: { increment: 1 } } : {}),
          ...(!draw && won  ? { matches_won:  { increment: 1 }, elo_rating: { increment: 15 } } : {}),
          ...(!draw && !won ? { matches_lost: { increment: 1 }, elo_rating: { decrement: 10 } } : {}),
        },
      })
    }
    this.logger.log(`Updated ELO for match ${matchGroupId}`)
  }
}
