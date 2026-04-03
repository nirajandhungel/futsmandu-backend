// apps/player-api/src/modules/match/match.module.ts
import { Module } from '@nestjs/common'
import { MatchService } from './match.service.js'
import { MatchController } from './match.controller.js'
import { QueuesModule } from '@futsmandu/queues'
@Module({
  imports: [QueuesModule],
  providers: [MatchService], controllers: [MatchController],
})
export class MatchModule {}
