#!/usr/bin/env node
// scripts/validate-env.mjs
// Run during `pnpm setup` to fail fast if any required env var is missing.
// Required keys are defined by .env.example — every key listed there must
// be present in .env (or the current process environment).
//
// Usage: node scripts/validate-env.mjs

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const envPath        = path.join(root, '.env')
const envExamplePath = path.join(root, '.env.example')

if (!fs.existsSync(envExamplePath)) {
  console.warn('⚠️  .env.example not found — skipping env validation.')
  process.exit(0)
}

if (!fs.existsSync(envPath)) {
  console.error('❌  .env file not found.')
  console.error('    Copy .env.example → .env and fill in real values.')
  process.exit(1)
}

const require = createRequire(import.meta.url)

try {
  const dotenvSafe = require('dotenv-safe')
  dotenvSafe.config({
    path:    envPath,
    example: envExamplePath,
    // Allow empty values — only check keys exist, not that they have values.
    // Set to false here so vars like UPSTASH_REDIS_IOREDIS_URL= (empty in example) don't fail.
    allowEmptyValues: true,
  })
  console.log('✅  Environment validated — all required keys are present.')
} catch (/** @type {any} */ err) {
  console.error('❌  Missing environment variables detected:')
  if (err && typeof err === 'object' && 'missing' in err) {
    /** @type {string[]} */ (err.missing).forEach((k) => console.error(`    • ${k}`))
  } else {
    console.error('   ', err instanceof Error ? err.message : String(err))
  }
  console.error('\n    Add the missing keys to your .env file and try again.')
  process.exit(1)
}
