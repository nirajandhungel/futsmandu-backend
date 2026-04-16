// packages/media/src/media.module.ts

import {
  Module,
  DynamicModule,
  Global,
} from '@nestjs/common'

import { BullModule } from '@nestjs/bullmq'

import { StorageModule, StorageService } from '@futsmandu/media-storage'
import { DatabaseModule } from '@futsmandu/database'
import { RedisModule } from '@futsmandu/redis'
import { QueuesModule } from '@futsmandu/queues'

import { QUEUE_IMAGE_PROCESSING } from '@futsmandu/queues'
import { ENV } from '@futsmandu/utils'

import { MediaService } from './media.service.js'

import {
  ImageProcessingProcessor,
  S3_CLIENT_TOKEN,
  S3_BUCKET_NAME_TOKEN,
} from '@futsmandu/media-processing'

/* ───────────────────────────────────────────────
   SAFE ENV VALIDATION (prevents silent failures)
─────────────────────────────────────────────── */

function requireEnv(key: keyof typeof ENV): string {
  const value = ENV[key] as string | undefined
  if (!value) {
    throw new Error(`[MediaModule] Missing env: ${String(key)}`)
  }
  return value
}

/* ───────────────────────────────────────────────
   S3 Providers (single source of truth)
─────────────────────────────────────────────── */

const S3_PROVIDERS = [
  {
    provide: S3_CLIENT_TOKEN,
    useFactory: (storage: StorageService) => {
      // ensures StorageModule is the ONLY S3 owner
      return storage.s3Client
    },
    inject: [StorageService],
  },

  {
    provide: S3_BUCKET_NAME_TOKEN,
    useFactory: () => requireEnv('S3_BUCKET'),
  },
]

/* ───────────────────────────────────────────────
   MODULE
─────────────────────────────────────────────── */

@Global()
@Module({
  imports: [
    DatabaseModule,
    StorageModule.register(),
    RedisModule,
    QueuesModule,
  ],

  providers: [
    MediaService,
    ...S3_PROVIDERS,
  ],

  exports: [
    MediaService,
  ],
})
export class MediaModule {

  /**
   * API MODE
   * - used by owner-api / user-api
   * - NO workers registered
   */
  static forApi(): DynamicModule {
    return {
      module: MediaModule,
    }
  }

  /**
   * WORKER MODE
   * - used by image-processing worker
   * - includes BullMQ processor
   */
  static forWorker(): DynamicModule {
    return {
      module: MediaModule,

      imports: [
        DatabaseModule,
        StorageModule.register(),
        RedisModule,
        QueuesModule,

        BullModule.registerQueue({
          name: QUEUE_IMAGE_PROCESSING,
        }),
      ],

      providers: [
        MediaService,
        ...S3_PROVIDERS,
        ImageProcessingProcessor,
      ],

      exports: [
        MediaService,
      ],
    }
  }
}