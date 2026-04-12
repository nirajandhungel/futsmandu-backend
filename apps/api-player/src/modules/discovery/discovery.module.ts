// apps/player-api/src/modules/discovery/discovery.module.ts
import { Module } from '@nestjs/common'
import { DiscoveryService } from './discovery.service.js'
import { DiscoveryController } from './discovery.controller.js'
@Module({ providers: [DiscoveryService], controllers: [DiscoveryController] })
export class DiscoveryModule {}
