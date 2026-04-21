import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { MediaModule } from '@futsmandu/media'
import { AdminOwnersController } from './admin-owners.controller.js'
import { AdminOwnersService } from './admin-owners.service.js'

@Module({
  imports: [
    MediaModule,
    BullModule.registerQueue({
      name: 'admin-emails',
    }),
  ],
  controllers: [AdminOwnersController],
  providers: [AdminOwnersService],
  exports: [AdminOwnersService],
})
export class AdminOwnersModule {}
