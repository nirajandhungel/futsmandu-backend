import { Module } from '@nestjs/common';
import { AdminMatchesController } from './admin-matches.controller.js';
import { AdminMatchesService } from './admin-matches.service.js';

@Module({
  controllers: [AdminMatchesController],
  providers: [AdminMatchesService],
  exports: [AdminMatchesService],
})
export class AdminMatchesModule {}
