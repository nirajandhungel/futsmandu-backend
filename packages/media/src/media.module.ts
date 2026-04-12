// packages/media/src/media.module.ts

import { Global, Module, DynamicModule } from '@nestjs/common'
import { S3Client } from '@aws-sdk/client-s3'
import { MediaService } from './media.service.js'
import { StorageModule } from './storage.module.js'
import { QueuesModule } from '@futsmandu/queues'
import {
  ImageProcessingProcessor,
  S3_CLIENT_TOKEN,
  S3_BUCKET_NAME_TOKEN,
} from '@futsmandu/media-processing'
import { ENV } from '@futsmandu/utils'

// The processor needs a raw S3Client (for streaming GetObject/PutObject).
// We provide it here using the same env vars as StorageService.
const s3ClientProvider = {
  provide:    S3_CLIENT_TOKEN,
  useFactory: () => {
    return new S3Client({
      region:         ENV['S3_REGION']  || 'auto',
      endpoint:       ENV['S3_ENDPOINT'] || '',
      forcePathStyle: ENV['S3_FORCE_PATH_STYLE'] === 'true',
      credentials: {
        accessKeyId:     ENV['S3_ACCESS_KEY'] || '',
        secretAccessKey: ENV['S3_SECRET_KEY'] || '',
      },
    })
  },
}

const s3BucketProvider = {
  provide:    S3_BUCKET_NAME_TOKEN,
  useFactory: () => ENV['S3_BUCKET'] || '',
}

@Global()
@Module({
  imports:   [QueuesModule, StorageModule.register()],
  providers: [s3ClientProvider, s3BucketProvider, MediaService],
  exports:   [MediaService],
})
export class MediaModule {
  /** Use in the worker app to also register the BullMQ processor. */
  static forWorker(): DynamicModule {
    return {
      module:    MediaModule,
      imports:   [QueuesModule, StorageModule.register()],
      providers: [s3ClientProvider, s3BucketProvider, MediaService, ImageProcessingProcessor],
      exports:   [MediaService],
    }
  }
}