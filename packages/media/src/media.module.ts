// packages/media/src/media.module.ts
// ─── ADDITIVE UPDATE ──────────────────────────────────────────────────────────
// Added: R2StorageModule.register() import so R2StorageService is available
//        to the updated MediaService.getSignedImageUrl() methods.
// All existing providers and exports are preserved.
// ─────────────────────────────────────────────────────────────────────────────

import { Module, DynamicModule, Global } from '@nestjs/common'
import { MediaService } from './media.service.js'
import { QueuesModule } from '@futsmandu/queues'
import { ImageProcessingProcessor, S3_CLIENT_TOKEN, S3_BUCKET_NAME_TOKEN } from '@futsmandu/media-processing'
import { createS3Client, StorageConfig } from '@futsmandu/media-storage'
import { R2StorageModule } from '@futsmandu/r2-storage'   // ← NEW
import { ENV } from '@futsmandu/utils'

import { MEDIA_STORAGE_CONFIG } from './media.constants.js'

export { MEDIA_STORAGE_CONFIG }

const s3ClientFactory = {
  provide: S3_CLIENT_TOKEN,
  useFactory: () => {
    return createS3Client({
      endpoint: ENV['S3_ENDPOINT'] || '',
      region: ENV['S3_REGION'] || 'us-east-1',
      accessKeyId: ENV['S3_ACCESS_KEY'] || '',
      secretAccessKey: ENV['S3_SECRET_KEY'] || '',
      forcePathStyle: ENV['S3_FORCE_PATH_STYLE'] === 'true',
    })
  },
}

const s3BucketNameFactory = {
  provide: S3_BUCKET_NAME_TOKEN,
  useFactory: () => ENV['S3_BUCKET'] || '',
}

const storageConfigFactory = {
  provide: MEDIA_STORAGE_CONFIG,
  useFactory: (s3Client: any, bucket: string): StorageConfig => ({
    s3Client,
    bucket,
  }),
  inject: [S3_CLIENT_TOKEN, S3_BUCKET_NAME_TOKEN],
}

@Global()
@Module({
  imports:   [QueuesModule, R2StorageModule.register()],   // ← R2StorageModule added
  providers: [s3ClientFactory, s3BucketNameFactory, storageConfigFactory, MediaService],
  exports:   [MediaService, MEDIA_STORAGE_CONFIG],
})
export class MediaModule {
  static forWorker(): DynamicModule {
    return {
      module:    MediaModule,
      imports:   [QueuesModule, R2StorageModule.register()],   // ← R2StorageModule added
      providers: [s3ClientFactory, s3BucketNameFactory, storageConfigFactory, MediaService, ImageProcessingProcessor],
      exports:   [MediaService, MEDIA_STORAGE_CONFIG],
    }
  }
}
