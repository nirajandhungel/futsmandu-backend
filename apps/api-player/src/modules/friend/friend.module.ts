// apps/player-api/src/modules/friend/friend.module.ts
import { Module } from '@nestjs/common'
import { FriendService } from './friend.service.js'
import { FriendController } from './friend.controller.js'
import { QueuesModule } from '@futsmandu/queues'

@Module({
  imports: [QueuesModule],
  providers: [FriendService],
  controllers: [FriendController],
})
export class FriendModule {}