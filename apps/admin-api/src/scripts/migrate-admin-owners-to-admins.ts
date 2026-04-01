import { PrismaService } from '@futsmandu/database'
import { ENV } from '@futsmandu/utils'

type AdminRole = 'ADMIN' | 'SUPER_ADMIN'

const ALLOWED_ROLES: AdminRole[] = ['ADMIN', 'SUPER_ADMIN']

function getEnvBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name]
  if (v === undefined) return defaultValue
  return v.toLowerCase() === 'true'
}

function extractAdminRoleFromVerificationDocs(
  verificationDocs: unknown,
): AdminRole | null {
  if (!verificationDocs || typeof verificationDocs !== 'object' || Array.isArray(verificationDocs)) return null
  const role = (verificationDocs as Record<string, unknown>)['adminRole']
  if (typeof role !== 'string') return null
  if (!ALLOWED_ROLES.includes(role as AdminRole)) return null
  return role as AdminRole
}

async function main() {
  if (!ENV['DATABASE_URL']) {
    throw new Error('DATABASE_URL is not set (required to connect Prisma)')
  }

  const deleteOwners = getEnvBool('ADMIN_MIGRATION_DELETE_OWNERS', false)
  const dryRun = !deleteOwners

  console.log(`[migrate:admins] Starting migration (deleteOwners=${deleteOwners})`)

  const prisma = new PrismaService()
  try {
    await prisma.$connect()

    const adminLikeOwners = await prisma.owners.findMany({
      where: {
        OR: [
          { verification_docs: { path: ['adminRole'], equals: 'ADMIN' } },
          { verification_docs: { path: ['adminRole'], equals: 'SUPER_ADMIN' } },
        ],
      },
      select: {
        id: true,
        email: true,
        name: true,
        password_hash: true,
        is_active: true,
        created_at: true,
        updated_at: true,
        verification_docs: true,
      },
    })

    console.log(`[migrate:admins] Found ${adminLikeOwners.length} admin-like owners.`)

    let createdAdmins = 0
    let updatedAdmins = 0

    // Create or update admins by email, preserving the existing password hash.
    if (adminLikeOwners.length > 0) {
      for (const o of adminLikeOwners) {
        const role = extractAdminRoleFromVerificationDocs(o.verification_docs)
        if (!role) continue

        const existing = await prisma.admins.findUnique({
          where: { email: o.email },
          select: { id: true },
        })
        if (!existing) createdAdmins++
        else updatedAdmins++

        await prisma.admins.upsert({
          where: { email: o.email },
          update: {
            name: o.name,
            role: role as any,
            password_hash: o.password_hash,
            is_active: o.is_active,
          },
          create: {
            id: o.id as any,
            email: o.email,
            name: o.name,
            role: role as any,
            password_hash: o.password_hash,
            is_active: o.is_active,
            createdAt: o.created_at as any,
            updatedAt: o.updated_at as any,
          },
        })
      }

      console.log(`[migrate:admins] Admins upserted: created=${createdAdmins} updated=${updatedAdmins}`)
    } else {
      console.log('[migrate:admins] No admin-like owners found — skipping admins upsert.')
    }

    // Sync legacy verification fields so owner-api/admin-api continue working during transition.
    await prisma.owners.updateMany({
      where: { is_verified: true },
      data: {
        isKycApproved: true,
        kycApprovedAt: null,
        kycApprovedById: null,
      },
    })
    await prisma.owners.updateMany({
      where: { is_verified: false },
      data: {
        isKycApproved: false,
        kycApprovedAt: null,
        kycApprovedById: null,
      },
    })
    await prisma.venues.updateMany({
      where: { is_verified: true },
      data: {
        isApproved: true,
        approvedAt: null,
        approvedById: null,
      },
    })
    await prisma.venues.updateMany({
      where: { is_verified: false },
      data: {
        isApproved: false,
        approvedAt: null,
        approvedById: null,
      },
    })

    console.log('[migrate:admins] Synced legacy verification booleans → new approval booleans.')

    if (dryRun) {
      console.log('[migrate:admins] Dry run enabled — skipping deletions.')
      return
    }

    if (adminLikeOwners.length === 0) {
      console.log('[migrate:admins] No delete candidates found.')
      return
    }

    const adminOwnerIds = adminLikeOwners.map((o: any) => o.id)

    // Staff accounts live in owners table too, and are linked via verification_docs.parentOwnerId (JSON).
    // If we delete an admin-like owner, we also delete any staff whose parentOwnerId points to those deleted owners.
    const deleteOwnerIds = new Set<string>(adminOwnerIds)
    for (const adminOwnerId of adminOwnerIds) {
      const staff = await prisma.owners.findMany({
        where: {
          verification_docs: { path: ['parentOwnerId'], equals: adminOwnerId },
        },
        select: { id: true },
      })
      for (const s of staff) deleteOwnerIds.add(s.id)
    }

    const deleteIdsArray = Array.from(deleteOwnerIds)
    console.log(`[migrate:admins] Deletion set size=${deleteIdsArray.length} (adminLike=${adminOwnerIds.length}, staff+=${deleteIdsArray.length - adminOwnerIds.length})`)

    // FK-safety: venues.owner_id references owners.id (FK), so we must abort if any venues are owned by a row we're about to delete.
    const conflictVenues = await prisma.venues.findMany({
      where: { owner_id: { in: deleteIdsArray } },
      select: { id: true, owner_id: true, name: true },
      take: 25,
    })
    if (conflictVenues.length > 0) {
      console.error('[migrate:admins] Aborting: cannot delete admin-like owners because venues reference them (FK safety).')
      console.error('[migrate:admins] Conflicting venues (showing up to 25):', conflictVenues)
      throw new Error('ADMIN_MIGRATION_DELETE_OWNERS would violate FK constraints (venues.owner_id)')
    }

    const deleted = await prisma.owners.deleteMany({
      where: { id: { in: deleteIdsArray } },
    })
    console.log(`[migrate:admins] Deleted owners/staff rows count=${deleted.count}`)
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}

main().catch((e: unknown) => {
  console.error('[migrate:admins] Failure', e)
  process.exitCode = 1
})

