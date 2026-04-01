import * as bcrypt from 'bcryptjs'
import { PrismaService } from '@futsmandu/database'
import type { admin_role as AdminRole } from '@futsmandu/database'
import { ENV } from '@futsmandu/utils'

const DEFAULT_EMAIL = 'subashdhungel555@gmail.com'
const DEFAULT_ROLE = 'ADMIN'
const DEFAULT_NAME = 'Seed Admin'

function readRequiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return v
}

async function hashPassword(plain: string, rounds: number): Promise<string> {
  return bcrypt.hash(plain, rounds)
}

async function seedAdmin(prisma: PrismaService): Promise<void> {
  const email = process.env.ADMIN_SEED_EMAIL ?? DEFAULT_EMAIL
  const password = readRequiredEnv('ADMIN_SEED_PASSWORD')

  const roleEnv = process.env.ADMIN_SEED_ROLE ?? DEFAULT_ROLE
  if (!['ADMIN', 'SUPER_ADMIN'].includes(roleEnv)) {
    throw new Error(`ADMIN_SEED_ROLE must be 'ADMIN' or 'SUPER_ADMIN' (got: ${roleEnv})`)
  }
  const role = roleEnv as AdminRole

  const rounds = Number.parseInt(process.env.ADMIN_SEED_BCRYPT_ROUNDS ?? '12', 10)
  if (!Number.isFinite(rounds) || rounds < 4 || rounds > 20) {
    throw new Error(`ADMIN_SEED_BCRYPT_ROUNDS must be an integer between 4 and 20 (got: ${rounds})`)
  }

  const isActive = (process.env.ADMIN_SEED_IS_ACTIVE ?? 'true').toLowerCase() === 'true'
  const nameEnv = process.env.ADMIN_SEED_NAME
  const name = nameEnv ?? DEFAULT_NAME

  if (!ENV['DATABASE_URL']) {
    throw new Error('DATABASE_URL is not set (required to connect Prisma)')
  }

  console.log(`[seed:admin] Starting seed for email=${email} role=${role}`)

  const existing = await prisma.admins.findUnique({
    where: { email },
    select: {
      id: true,
      password_hash: true,
      name: true,
      role: true,
      is_active: true,
    },
  })

  const passwordHash = await hashPassword(password, rounds)

  if (!existing) {
    const created = await prisma.admins.create({
      data: {
        name,
        email,
        password_hash: passwordHash,
        is_active: isActive,
        role,
      },
      select: { id: true, email: true },
    })
    console.log(`[seed:admin] Success: created admin account id=${created.id} email=${created.email}`)
    return
  }

  // Idempotent update: no duplicate creation, but ensure role + password hash are correct.
  await prisma.admins.update({
    where: { id: existing.id },
    data: {
      name: nameEnv ?? existing.name,
      password_hash: passwordHash,
      is_active: isActive,
      role,
    },
    select: { id: true, email: true },
  })
  console.log(`[seed:admin] Success: updated existing admin id=${existing.id} email=${email}`)
}

async function main() {
  const prisma = new PrismaService()
  try {
    await prisma.$connect()
    await seedAdmin(prisma)
  } catch (err: unknown) {
    console.error('[seed:admin] Failure')
    console.error(err)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}

main()
process.on('unhandledRejection', (reason) => {
  console.error('[seed:admin] Unhandled promise rejection', reason)
  process.exitCode = 1
})

