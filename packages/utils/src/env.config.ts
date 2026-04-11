import dotenv from 'dotenv'
import * as path from 'path'
import { fileURLToPath } from 'url'

// Load .env from the monorepo root BEFORE any process.env access.
// `override: false` means shell / platform env vars (Render, Docker) always win
// over the file — correct behaviour for production deployments.
// env.config.ts lives at `packages/utils/src/`, so `../../../` -> repo root.
const _root = fileURLToPath(new URL('../../../', import.meta.url))
dotenv.config({ path: path.join(_root, '.env'), override: false })

// ── Centralized environment config ────────────────────────────────────────────
// All process.env access is confined to this file.
// Every other module imports from ENV — never from process.env directly.
export const ENV = {
  NODE_ENV: process.env['NODE_ENV'] ?? 'development',

  // ── Database ────────────────────────────────────────────────────────────────
  DATABASE_URL:           process.env['DATABASE_URL']          as string,
  DIRECT_DATABASE_URL:    process.env['DIRECT_DATABASE_URL']   as string,
  DB_POOL_SIZE:           process.env['DB_POOL_SIZE']          ?? '2',
  OWNER_DB_POOL_SIZE:     process.env['OWNER_DB_POOL_SIZE']    ?? '2',
  ADMIN_DB_POOL_SIZE:     process.env['ADMIN_DB_POOL_SIZE']    ?? '2',
  WORKER_DB_POOL_SIZE:    process.env['WORKER_DB_POOL_SIZE']   ?? '1',

  // ── Redis — Upstash ioredis ONLY (rediss://) ────────────────────────────────
  // This is the single, canonical Redis connection used by every service.
  // REDIS_URL (local/plaintext) and UPSTASH_REDIS_REST_* are intentionally removed:
  //   • REDIS_URL   — no local Redis exists in production; accepting it is a footgun.
  //   • REST vars   — the REST Upstash client is not instantiated anywhere in this codebase.
  UPSTASH_REDIS_IOREDIS_URL: process.env['UPSTASH_REDIS_IOREDIS_URL'] as string,

  // ── JWT — one secret per service ────────────────────────────────────────────
  PLAYER_JWT_SECRET: process.env['PLAYER_JWT_SECRET'] as string,
  OWNER_JWT_SECRET:  process.env['OWNER_JWT_SECRET']  as string,
  ADMIN_JWT_SECRET:  process.env['ADMIN_JWT_SECRET']  as string,

  // ── Payments ─────────────────────────────────────────────────────────────────
  KHALTI_SECRET_KEY:  process.env['KHALTI_SECRET_KEY']  as string,
  ESEWA_SECRET_KEY:   process.env['ESEWA_SECRET_KEY']   as string,
  ESEWA_PRODUCT_CODE: process.env['ESEWA_PRODUCT_CODE'] as string,
  // Payout API keys fall back to existing eSewa config for compatibility.
  ESEWA_MERCHANT_CODE: process.env['ESEWA_MERCHANT_CODE'] ?? process.env['ESEWA_PRODUCT_CODE'] ?? '',
  ESEWA_MERCHANT_SECRET: process.env['ESEWA_MERCHANT_SECRET'] ?? process.env['ESEWA_SECRET_KEY'] ?? '',

  // ── Storage (Provider-agnostic) ───────────────────────────────────────────
  STORAGE_PROVIDER:    process.env['STORAGE_PROVIDER']    as string,
  S3_ENDPOINT:         process.env['S3_ENDPOINT']         as string,
  S3_REGION:           process.env['S3_REGION']           as string,
  S3_ACCESS_KEY:       process.env['S3_ACCESS_KEY']       as string,
  S3_SECRET_KEY:       process.env['S3_SECRET_KEY']       as string,
  S3_BUCKET:           process.env['S3_BUCKET']           as string,
  S3_FORCE_PATH_STYLE: process.env['S3_FORCE_PATH_STYLE'] as string,
  S3_CDN_BASE_URL:     process.env['S3_CDN_BASE_URL']     as string,
  USE_SIGNED_IMAGE_URLS: process.env['USE_SIGNED_IMAGE_URLS'] ?? 'false',


  // ── Notifications ──────────────────────────────────────────────────────────
  FIREBASE_SERVICE_ACCOUNT: process.env['FIREBASE_SERVICE_ACCOUNT'] as string,
  SPARROW_SMS_TOKEN:        process.env['SPARROW_SMS_TOKEN']         as string,
  RESEND_API_KEY:            process.env['RESEND_API_KEY']            as string,

  // ── OTP (Email Verification) ───────────────────────────────────────────────
  OTP_EXPIRY_MINUTES: parseInt(process.env['OTP_EXPIRY_MINUTES'] ?? '10', 10),
  OTP_MAX_ATTEMPTS:   parseInt(process.env['OTP_MAX_ATTEMPTS'] ?? '5', 10),
  OTP_LENGTH:         parseInt(process.env['OTP_LENGTH'] ?? '6', 10),

  // ── App ───────────────────────────────────────────────────────────────────
  APP_URL:           process.env['APP_URL']           as string,
  ADMIN_ALLOWED_IPS: process.env['ADMIN_ALLOWED_IPS'] as string,
  SENTRY_DSN:                process.env['SENTRY_DSN']                as string,
  SENTRY_ENVIRONMENT:        process.env['SENTRY_ENVIRONMENT']        ?? (process.env['NODE_ENV'] ?? 'development'),
  SENTRY_RELEASE:            process.env['SENTRY_RELEASE']            ?? process.env['npm_package_version'],
  SENTRY_TRACES_SAMPLE_RATE: process.env['SENTRY_TRACES_SAMPLE_RATE'] ?? '0.1',

  // ── Ports ─────────────────────────────────────────────────────────────────
  PLAYER_API_PORT: process.env['PLAYER_API_PORT'] ?? '3001',
  OWNER_API_PORT:  process.env['OWNER_API_PORT']  ?? '3002',
  ADMIN_API_PORT:  process.env['ADMIN_API_PORT']  ?? '3003',

  // ── Runtime ───────────────────────────────────────────────────────────────
  npm_package_version: process.env['npm_package_version'] as string,
  HOSTNAME:            process.env['HOSTNAME']            as string,
  MEDIA_ORPHAN_MAX_AGE_HOURS: parseInt(process.env['MEDIA_ORPHAN_MAX_AGE_HOURS'] ?? '24', 10),
  MEDIA_ORPHAN_SCAN_EVERY_MINUTES: parseInt(process.env['MEDIA_ORPHAN_SCAN_EVERY_MINUTES'] ?? '30', 10),
} as const

// ── Boot-time validation ──────────────────────────────────────────────────────
// Call validateENV() as the very first line of each service's bootstrap().
// Pass any service-specific required keys alongside the always-required set.
// Will process.exit(1) with a clear diagnostic rather than crashing at runtime.

type EnvKey = keyof typeof ENV

/** Keys that must be present in every service. */
const ALWAYS_REQUIRED: EnvKey[] = [
  'DATABASE_URL',
  'DIRECT_DATABASE_URL',
  'UPSTASH_REDIS_IOREDIS_URL',
]

/** Additional keys required only in production. */
const PROD_REQUIRED: EnvKey[] = []

export function validateENV(serviceKeys: EnvKey[] = []): void {
  const required: EnvKey[] = [...ALWAYS_REQUIRED, ...serviceKeys]
  if (ENV.NODE_ENV === 'production') required.push(...PROD_REQUIRED)

  const missing = required.filter(k => !ENV[k])
  if (missing.length > 0) {
    console.error(
      `[ENV] FATAL — missing required environment variables:\n` +
      missing.map(k => `  • ${k}`).join('\n') + '\n' +
      'Copy .env.example → .env and fill in all values.',
    )
    process.exit(1)
  }

  // Upstash requires TLS — catch accidental plaintext URLs early.
  if (!ENV.UPSTASH_REDIS_IOREDIS_URL.startsWith('rediss://')) {
    console.error(
      '[ENV] FATAL — UPSTASH_REDIS_IOREDIS_URL must start with rediss:// ' +
      '(Upstash requires TLS). Got: ' + ENV.UPSTASH_REDIS_IOREDIS_URL.slice(0, 20) + '...',
    )
    process.exit(1)
  }
}
