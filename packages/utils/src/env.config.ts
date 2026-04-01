import * as dotenv from 'dotenv'
import * as path from 'path'
import { fileURLToPath } from 'url'

// Resolve .env files relative to the monorepo root.
// Do NOT use `process.cwd()` because worker processes may start with a different cwd.
// env.config.ts lives at `packages/utils/src/`, so `../../../` -> repo root.
const root = fileURLToPath(new URL('../../../', import.meta.url))
dotenv.config({ path: path.join(root, '.env') })
dotenv.config({ path: path.join(root, '.env.admin') })
dotenv.config({ path: path.join(root, '.env.dev') })

export const ENV = {
    NODE_ENV: process.env['NODE_ENV'] || 'development',
    DATABASE_URL: process.env['DATABASE_URL'] as string,
    DIRECT_DATABASE_URL: process.env['DIRECT_DATABASE_URL'] as string,
    PLAYER_JWT_SECRET: process.env['PLAYER_JWT_SECRET'] as string,
    OWNER_JWT_SECRET: process.env['OWNER_JWT_SECRET'] as string,
    ADMIN_JWT_SECRET: process.env['ADMIN_JWT_SECRET'] as string,
    // Preferred across dev/prod. Example: redis://localhost:6379
    REDIS_URL: process.env['REDIS_URL'] as string | undefined,
    // Legacy (Upstash). Used only if REDIS_URL is not set.
    UPSTASH_REDIS_REST_URL: process.env['UPSTASH_REDIS_REST_URL'] as string | undefined,
    UPSTASH_REDIS_REST_TOKEN: process.env['UPSTASH_REDIS_REST_TOKEN'] as string | undefined,
    UPSTASH_REDIS_IOREDIS_URL: process.env['UPSTASH_REDIS_IOREDIS_URL'] as string | undefined,
    KHALTI_SECRET_KEY: process.env['KHALTI_SECRET_KEY'] as string,
    ESEWA_SECRET_KEY: process.env['ESEWA_SECRET_KEY'] as string,
    ESEWA_PRODUCT_CODE: process.env['ESEWA_PRODUCT_CODE'] as string,
    CF_ACCOUNT_ID: process.env['CF_ACCOUNT_ID'] as string,
    R2_ACCESS_KEY_ID: process.env['R2_ACCESS_KEY_ID'] as string,
    R2_SECRET_ACCESS_KEY: process.env['R2_SECRET_ACCESS_KEY'] as string,
    R2_BUCKET_NAME: process.env['R2_BUCKET_NAME'] as string,
    R2_CDN_BASE_URL: process.env['R2_CDN_BASE_URL'] as string,
    SPARROW_SMS_TOKEN: process.env['SPARROW_SMS_TOKEN'] as string,
    RESEND_API_KEY: process.env['RESEND_API_KEY'] as string,
    APP_URL: process.env['APP_URL'] as string,
    DB_POOL_SIZE: process.env['DB_POOL_SIZE'] as string,
    ADMIN_ALLOWED_IPS: process.env['ADMIN_ALLOWED_IPS'] as string,
    SENTRY_DSN: process.env['SENTRY_DSN'] as string,
    FIREBASE_SERVICE_ACCOUNT: process.env['FIREBASE_SERVICE_ACCOUNT'] as string,
    ADMIN_API_PORT: process.env['ADMIN_API_PORT'] as string,
    OWNER_API_PORT: process.env['OWNER_API_PORT'] as string,
    PLAYER_API_PORT: process.env['PLAYER_API_PORT'] as string,
    npm_package_version: process.env['npm_package_version'] as string,
    HOSTNAME: process.env['HOSTNAME'] as string,
} as const
