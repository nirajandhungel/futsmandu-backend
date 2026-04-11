/**
 * @futsmandu/r2-storage — NestJS module
 *
 * Import R2StorageModule.register() in any NestJS app module.
 * The module is marked @Global() so that R2StorageService is available
 * throughout the module tree without re-importing.
 *
 * Usage:
 *   R2StorageModule.register()   ← reads from ENV automatically
 */

import { Global, Module, DynamicModule } from '@nestjs/common'
import { R2StorageService, type R2StorageOptions } from './r2-storage.service.js'
import { ENV } from '@futsmandu/utils'

export const R2_STORAGE_OPTIONS = 'R2_STORAGE_OPTIONS'

function defaultOptions(): R2StorageOptions {
  return {
    endpoint:        ENV['S3_ENDPOINT']    || '',
    region:          ENV['S3_REGION']      || 'auto',
    accessKeyId:     ENV['S3_ACCESS_KEY']  || '',
    secretAccessKey: ENV['S3_SECRET_KEY']  || '',
    bucket:          ENV['S3_BUCKET']      || '',
    enableCache:     ENV['USE_SIGNED_IMAGE_URLS'] !== 'false',  // cache on unless explicitly disabled
    defaultGetExpirySeconds: 3_600, // 1 hour
  }
}

@Global()
@Module({})
export class R2StorageModule {
  /**
   * register() — reads all config from ENV (standard for prod deployments).
   * Call this in app.module.ts.
   */
  static register(overrides: Partial<R2StorageOptions> = {}): DynamicModule {
    return {
      module: R2StorageModule,
      providers: [
        {
          provide:    R2_STORAGE_OPTIONS,
          useFactory: (): R2StorageOptions => ({ ...defaultOptions(), ...overrides }),
        },
        {
          provide:    R2StorageService,
          useFactory: (opts: R2StorageOptions) => new R2StorageService(opts),
          inject:     [R2_STORAGE_OPTIONS],
        },
      ],
      exports: [R2StorageService],
    }
  }
}
