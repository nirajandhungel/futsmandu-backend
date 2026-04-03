// apps/owner-api/src/modules/media/media.module.ts
import { Module } from '@nestjs/common'
import { MediaService } from './media.service.js'
import { MediaController } from './media.controller.js'
import { QueuesModule } from '@futsmandu/queues'

@Module({
  imports: [QueuesModule],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
