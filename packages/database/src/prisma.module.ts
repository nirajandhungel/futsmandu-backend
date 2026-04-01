// packages/database/src/prisma.module.ts
// Global NestJS module — import once in AppModule, available everywhere.
// @Global() means other modules don't need to import it explicitly.

import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service.js'

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
