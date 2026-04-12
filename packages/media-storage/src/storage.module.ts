// packages/media-storage/src/storage.module.ts

import { Global, Module, DynamicModule } from '@nestjs/common'
import { StorageService, type StorageConfig } from './storage.service.js'
import { ENV } from '@futsmandu/utils'

export const STORAGE_CONFIG_TOKEN = 'STORAGE_CONFIG'

function defaultConfig(): StorageConfig {
  return {
    endpoint:               ENV['S3_ENDPOINT']    || '',
    region:                 ENV['S3_REGION']      || 'auto',
    accessKeyId:            ENV['S3_ACCESS_KEY']  || '',
    secretAccessKey:        ENV['S3_SECRET_KEY']  || '',
    bucket:                 ENV['S3_BUCKET']      || '',
    enableCache:            true,
    defaultGetExpirySeconds: 3_600,
    forcePathStyle:         ENV['S3_FORCE_PATH_STYLE'] === 'true',
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
          provide:    STORAGE_CONFIG_TOKEN,
          useFactory: (): StorageConfig => ({ ...defaultConfig(), ...overrides }),
        },
        {
          provide:    StorageService,
          useFactory: (config: StorageConfig) => new StorageService(config),
          inject:     [STORAGE_CONFIG_TOKEN],
        },
      ],
      exports: [StorageService],
    }
  }
}
