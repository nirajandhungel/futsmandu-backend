// apps/admin-api/src/instrument.ts
import * as dotenv from 'dotenv'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { initSentry } from '@futsmandu/sentry'

// Load .env from the monorepo root BEFORE Sentry init
const _root = fileURLToPath(new URL('../../../', import.meta.url))
dotenv.config({ path: path.join(_root, '.env'), override: false })

initSentry()