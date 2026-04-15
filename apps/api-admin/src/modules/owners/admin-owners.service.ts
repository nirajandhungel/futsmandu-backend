import {
  Injectable, NotFoundException, ConflictException, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import type { ListOwnersQueryDto } from './dto/admin-owner.dto.js'

// Owner status is derived from is_verified + is_active:
//   verified  = is_verified:true  AND is_active:true
//   pending   = is_verified:false AND is_active:true
//   suspended = is_active:false

@Injectable()
export class AdminOwnersService {
  private readonly logger = new Logger(AdminOwnersService.name)
  private readonly DEFAULT_PAGE_SIZE = 25

  constructor(private readonly prisma: PrismaService) {}

  // ── List owners (paginated, filtered, sorted) ─────────────────────────────

  async listOwners(query: ListOwnersQueryDto) {
    const page  = Math.max(1, query.page ?? 1)
    const limit = Math.min(100, Math.max(1, query.limit ?? this.DEFAULT_PAGE_SIZE))
    const skip  = (page - 1) * limit

    const where = this.buildOwnerWhere(query)

    const sortBy    = query.sortBy ?? 'created_at'
    const sortOrder = query.sortOrder ?? 'desc'

    const [owners, total] = await Promise.all([
      this.prisma.owners.findMany({
        where,
        select: {
          id: true, name: true, email: true, phone: true,
          business_name: true, is_verified: true, is_active: true,
          isKycApproved: true, esewa_id: true, esewa_verified: true,
          created_at: true,
          _count: { select: { venues: true } },
        },
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: limit,
      }),
      this.prisma.owners.count({ where }),
    ])

    return {
      data: owners,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  async getOwnerStats() {
    const [total, pending, suspended, verified] = await Promise.all([
      this.prisma.owners.count(),
      this.prisma.owners.count({ where: { is_verified: false, is_active: true } }),
      this.prisma.owners.count({ where: { is_active: false } }),
      this.prisma.owners.count({ where: { is_verified: true, is_active: true } }),
    ])
    return { total, pending, suspended, verified }
  }

  // ── Owner detail ──────────────────────────────────────────────────────────

  async getOwnerDetail(ownerId: string) {
    const owner = await this.prisma.owners.findUnique({
      where: { id: ownerId },
      select: {
        id: true, name: true, email: true, phone: true,
        business_name: true, is_verified: true, is_active: true,
        verification_docs: true,
        isKycApproved: true, kycApprovedAt: true, kycApprovedById: true,
        esewa_id: true, esewa_verified: true, esewa_verified_at: true,
        created_at: true, updated_at: true,
        venues: {
          select: {
            id: true, name: true, slug: true, is_verified: true, is_active: true,
            isApproved: true, avg_rating: true, total_reviews: true, created_at: true,
            _count: { select: { courts: true, bookings: true } },
          },
          orderBy: { created_at: 'desc' },
        },
      },
    })
    if (!owner) throw new NotFoundException('Owner not found')

    // Fetch recent audit log entries for this owner
    const auditHistory = await this.prisma.admin_audit_log.findMany({
      where: { target_id: ownerId, target_type: 'owners' },
      orderBy: { created_at: 'desc' },
      take: 20,
    })

    return { ...owner, auditHistory }
  }

  // ── Verify owner (idempotent) ─────────────────────────────────────────────

  async verifyOwner(adminId: string, ownerId: string) {
    const owner = await this.prisma.owners.findUnique({
      where: { id: ownerId },
      select: { id: true, name: true, is_verified: true, is_active: true },
    })
    if (!owner) throw new NotFoundException('Owner not found')

    // Cannot verify a suspended owner — must reinstate first
    if (!owner.is_active) {
      throw new ConflictException('Cannot verify a suspended owner — reinstate first')
    }

    // Idempotent: already verified
    if (owner.is_verified) {
      return { message: 'Owner already verified', ownerId }
    }

    await this.prisma.owners.update({
      where: { id: ownerId },
      data: {
        is_verified:     true,
        isKycApproved:   true,
        kycApprovedAt:   new Date(),
        kycApprovedById: adminId,
        updated_at:      new Date(),
      },
    })

    await this.writeAuditLog(adminId, 'OWNER_VERIFIED', ownerId)
    this.logger.log(`Owner ${ownerId} verified by admin ${adminId}`)
    return { message: 'Owner verified', ownerId }
  }

  // ── Suspend owner ─────────────────────────────────────────────────────────

  async suspendOwner(adminId: string, ownerId: string, reason: string) {
    const owner = await this.prisma.owners.findUnique({
      where: { id: ownerId },
      select: { id: true, name: true, is_active: true },
    })
    if (!owner) throw new NotFoundException('Owner not found')

    // Already suspended
    if (!owner.is_active) {
      throw new ConflictException('Owner is already suspended')
    }

    await this.prisma.owners.update({
      where: { id: ownerId },
      data: {
        is_active:  false,
        updated_at: new Date(),
      },
    })

    await this.writeAuditLog(adminId, 'OWNER_SUSPENDED', ownerId, { reason })
    this.logger.log(`Owner ${ownerId} suspended by admin ${adminId}: ${reason}`)
    return { message: 'Owner suspended', ownerId }
  }

  // ── Reinstate owner (idempotent) ──────────────────────────────────────────

  async reinstateOwner(adminId: string, ownerId: string) {
    const owner = await this.prisma.owners.findUnique({
      where: { id: ownerId },
      select: { id: true, name: true, is_active: true },
    })
    if (!owner) throw new NotFoundException('Owner not found')

    // Idempotent: already active
    if (owner.is_active) {
      return { message: 'Owner is already active', ownerId }
    }

    await this.prisma.owners.update({
      where: { id: ownerId },
      data: {
        is_active:  true,
        updated_at: new Date(),
      },
    })

    await this.writeAuditLog(adminId, 'OWNER_REINSTATED', ownerId)
    this.logger.log(`Owner ${ownerId} reinstated by admin ${adminId}`)
    return { message: 'Owner reinstated', ownerId }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private buildOwnerWhere(query: Pick<ListOwnersQueryDto, 'status' | 'search'>) {
    const where: Record<string, unknown> = {}

    if (query.status === 'verified') {
      where['is_verified'] = true
      where['is_active'] = true
    } else if (query.status === 'pending') {
      where['is_verified'] = false
      where['is_active'] = true
    } else if (query.status === 'suspended') {
      where['is_active'] = false
    }

    if (query.search?.trim()) {
      const search = query.search.trim()
      where['OR'] = [
        { name:          { contains: search, mode: 'insensitive' } },
        { email:         { contains: search, mode: 'insensitive' } },
        { phone:         { contains: search, mode: 'insensitive' } },
        { business_name: { contains: search, mode: 'insensitive' } },
      ]
    }

    return where
  }

  private async writeAuditLog(
    adminId: string,
    action: string,
    targetId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.admin_audit_log.create({
      data: {
        admin_id:    adminId,
        action,
        target_id:   targetId,
        target_type: 'owners',
        metadata:    metadata ?? undefined,
      },
    }).catch((err: unknown) => {
      this.logger.error('Failed to write audit log', String(err))
    })
  }

}
