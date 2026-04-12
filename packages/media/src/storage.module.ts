// packages/media/src/storage.module.ts
//
// NestJS DynamicModule wrapper around StorageService.
// Lives in packages/media (not media-storage) because NestJS is a media dep, not storage.

import { Global, Module, DynamicModule } from '@nestjs/common'
import { StorageService, type StorageConfig } from '@futsmandu/media-storage'
import { ENV } from '@futsmandu/utils'

export const STORAGE_SERVICE_TOKEN = 'STORAGE_SERVICE'

function defaultConfig(): StorageConfig {
  return {
    endpoint:                ENV['S3_ENDPOINT']    || '',
    region:                  ENV['S3_REGION']      || 'auto',
    accessKeyId:             ENV['S3_ACCESS_KEY']  || '',
    secretAccessKey:         ENV['S3_SECRET_KEY']  || '',
    bucket:                  ENV['S3_BUCKET']      || '',
    enableCache:             true,
    defaultGetExpirySeconds: 3_600,
    forcePathStyle:          ENV['S3_FORCE_PATH_STYLE'] === 'true',
  }
}

@Global()
@Module({})
export class StorageModule {
  static register(overrides: Partial<StorageConfig> = {}): DynamicModule {
    return {
      module: StorageModule,
      providers: [
        {
          provide:    StorageService,
          useFactory: () => new StorageService({ ...defaultConfig(), ...overrides }),
        },
      ],
      exports: [StorageService],
    }
  }
}