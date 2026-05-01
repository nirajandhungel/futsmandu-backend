import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PrismaService } from '@futsmandu/database'
import { ENV } from '@futsmandu/utils'
import { ConfigService } from '@nestjs/config'

type PlatformSeedItem = {
  key: string
  value: string
  type: string
  description?: string
}


type SeedConfigFile = {
  platformConfig: PlatformSeedItem[]
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${field}: must be a non-empty string`)
  }
  return value.trim()
}

function normalizeConfig(input: unknown): SeedConfigFile {
  if (!input || typeof input !== 'object') {
    throw new Error('Seed config must be a JSON object')
  }
  const file = input as Partial<SeedConfigFile>
  if (!Array.isArray(file.platformConfig)) {
    throw new Error('Missing or invalid "platformConfig" array')
  }
  const platformConfig = file.platformConfig.map((item, index) => {
    const candidate = item as PlatformSeedItem
    const type = assertString(candidate.type, `platformConfig[${index}].type`)
    if (!['number', 'boolean', 'string'].includes(type)) {
      throw new Error(`Invalid type at platformConfig[${index}].type: must be number, boolean, or string`)
    }
    const description = typeof candidate.description === 'string' ? candidate.description.trim() : undefined
    return {
      key: assertString(candidate.key, `platformConfig[${index}].key`),
      value: assertString(candidate.value, `platformConfig[${index}].value`),
      type,
      description,
    }
  })

  return { platformConfig }
}

async function loadSeedConfig(): Promise<SeedConfigFile> {
  const configPath =
    process.env['SEED_CONFIG_PATH'] ??
    path.resolve(process.cwd(), '../../seed-config.local.json')

  const raw = await readFile(configPath, 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  return normalizeConfig(parsed)
}

async function main() {
  if (!ENV['DATABASE_URL']) {
    throw new Error('DATABASE_URL is not set')
  }

  const prisma = new PrismaService(new ConfigService())
  try {
    await prisma.$connect()

    const seed = await loadSeedConfig()
    for (const item of seed.platformConfig) {
      await prisma.platform_config.upsert({
        where: { key: item.key },
        create: {
          key: item.key,
          value: item.value,
          type: item.type,
          description: item.description,
        },
        update: {
          value: item.value,
          type: item.type,
          description: item.description,
        },

      })
      console.log(`[seed:config] upserted ${item.key}=${item.value}`)
    }

    console.log('[seed:config] done')
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}

main().catch((err: unknown) => {
  console.error('[seed:config] failed')
  console.error(err)
  process.exit(1)
})
