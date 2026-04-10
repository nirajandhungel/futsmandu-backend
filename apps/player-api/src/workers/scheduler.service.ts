// apps/player-api/src/workers/scheduler.service.ts
// FIX: slot-expiry and payment-recon processors existed but were never scheduled.
// BullMQ @Processor only handles jobs — someone must ADD jobs with { repeat } config.
// Without this, the queues remain empty and neither processor ever fires.
//
// This service runs once at worker startup (OnModuleInit) and registers the
// two repeatable jobs idempotently. BullMQ deduplicates by jobId, so restarting
// the worker process does not create duplicate schedules.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { ENV } from '@futsmandu/utils'

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name)

  constructor(
    @InjectQueue('slot-expiry')   private readonly slotExpiryQueue: Queue,
    @InjectQueue('payment-recon') private readonly paymentReconQueue: Queue,
    @InjectQueue('media-orphan-cleanup') private readonly mediaOrphanCleanupQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.scheduleRepeatableJobs()
  }

  private async scheduleRepeatableJobs(): Promise<void> {
    try {
      // Slot expiry: runs every 2 minutes.
      // Fallback for holds whose Redis TTL key was lost — DB is the source of truth.
      await this.slotExpiryQueue.add(
        'run',
        {},
        {
          jobId: 'slot-expiry-recurring',
          repeat: { every: 2 * 60 * 1000 },
          removeOnComplete: 5,
          removeOnFail: 10,
        },
      )
      this.logger.log('Scheduled slot-expiry job (every 2 min)')
    } catch (err) {
      // Log but do not crash — if Redis is down at startup the repeatable schedule
      // cannot be stored; workers remain running and will retry on next restart.
      this.logger.error('Failed to schedule slot-expiry job', String(err))
    }

    try {
      // Payment reconciliation: runs every 15 minutes.
      // Catches bookings stuck in PENDING_PAYMENT whose gateway callback was missed.
      await this.paymentReconQueue.add(
        'run',
        {},
        {
          jobId: 'payment-recon-recurring',
          repeat: { every: 15 * 60 * 1000 },
          removeOnComplete: 5,
          removeOnFail: 10,
        },
      )
      this.logger.log('Scheduled payment-recon job (every 15 min)')
    } catch (err) {
      this.logger.error('Failed to schedule payment-recon job', String(err))
    }

    try {
      const everyMinutes = Math.max(ENV['MEDIA_ORPHAN_SCAN_EVERY_MINUTES'], 5)
      await this.mediaOrphanCleanupQueue.add(
        'run',
        {},
        {
          jobId: 'media-orphan-cleanup-recurring',
          repeat: { every: everyMinutes * 60 * 1000 },
          removeOnComplete: 5,
          removeOnFail: 10,
        },
      )
      this.logger.log(`Scheduled media-orphan-cleanup job (every ${everyMinutes} min)`)
    } catch (err) {
      this.logger.error('Failed to schedule media-orphan-cleanup job', String(err))
    }
  }
}
