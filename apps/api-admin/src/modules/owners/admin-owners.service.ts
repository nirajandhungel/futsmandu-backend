import { Injectable, NotFoundException, Logger, BadRequestException } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { MediaService } from '@futsmandu/media'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'

@Injectable()
export class AdminOwnersService {
  private readonly logger = new Logger(AdminOwnersService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    @InjectQueue('admin-emails') private readonly emailQueue: Queue,
  ) {}

  async listAllOwners(page = 1, search?: string, isActive?: boolean, isKycApproved?: boolean) {
    const PAGE_SIZE = 20
    const skip = (page - 1) * PAGE_SIZE

    const where: any = {}
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ]
    }
    if (isActive !== undefined) where.is_active = isActive
    if (isKycApproved !== undefined) where.is_kyc_approved = isKycApproved

    const [owners, total] = await Promise.all([
      this.prisma.owners.findMany({
        where,
        select: {
          id: true, name: true, email: true, phone: true, business_name: true,
          is_active: true, is_verified: true, is_kyc_approved: true, created_at: true,
          _count: { select: { venues: true, created_bookings: true } },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: PAGE_SIZE,
      }),
      this.prisma.owners.count({ where }),
    ])

    return { data: owners, meta: { page, total } }
  }

  async getOwnerDetails(ownerId: string) {
    const owner = await this.prisma.owners.findUnique({
      where: { id: ownerId },
      include: {
        venues: {
          select: { id: true, name: true, is_active: true, is_verified: true, created_at: true },
        },
        _count: { select: { created_bookings: true, payouts: true } },
      },
    })
    if (!owner) throw new NotFoundException('Owner not found')

    const payouts = await this.prisma.owner_payouts.aggregate({
      where: { owner_id: ownerId, status: 'SUCCESS' },
      _sum: { owner_amount: true },
    })

    return { ...owner, total_revenue: payouts._sum.owner_amount || 0 }
  }

  async updateOwnerStatus(ownerId: string, isActive: boolean) {
    const owner = await this.prisma.owners.findUnique({ where: { id: ownerId } })
    if (!owner) throw new NotFoundException('Owner not found')

    const updated = await this.prisma.owners.update({
      where: { id: ownerId },
      data: { is_active: isActive, updated_at: new Date() },
    })

    this.logger.log(`Owner ${ownerId} status changed to active=${isActive}`)
    return updated
  }

  async getKycDocuments(ownerId: string) {
    const owner = await this.prisma.owners.findUnique({
      where: { id: ownerId },
      select: { id: true },
    })
    if (!owner) throw new NotFoundException('Owner not found')

    const docTypes = ['citizenship', 'pan', 'business_reg']
    const urls = await Promise.all(
      docTypes.map(async (docType) => {
        try {
          const urlData = await this.media.getKycDocUrl(ownerId, docType, 600)
          return { type: docType, url: urlData.downloadUrl }
        } catch {
          return { type: docType, url: null }
        }
      })
    )

    return urls
  }

  async approveKyc(adminId: string, ownerId: string) {
    const owner = await this.prisma.owners.findUnique({ where: { id: ownerId } })
    if (!owner) throw new NotFoundException('Owner not found')
    if (owner.is_kyc_approved) throw new BadRequestException('KYC already approved')

    const updated = await this.prisma.owners.update({
      where: { id: ownerId },
      data: {
        is_kyc_approved: true,
        kyc_approved_at: new Date(),
        kyc_approved_by_id: adminId,
        is_verified: true,
        updated_at: new Date(),
      },
    })

    await this.emailQueue
      .add('kyc-approved', {
        to: owner.email,
        name: owner.name,
      }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })
      .catch((e: unknown) => this.logger.error('Email queue error', e))

    return { message: 'KYC approved', ownerId }
  }

  async rejectKyc(adminId: string, ownerId: string, reason: string) {
    const owner = await this.prisma.owners.findUnique({ where: { id: ownerId } })
    if (!owner) throw new NotFoundException('Owner not found')

    const updated = await this.prisma.owners.update({
      where: { id: ownerId },
      data: {
        is_kyc_approved: false,
        kyc_approved_at: null,
        kyc_approved_by_id: null,
        is_verified: false,
        updated_at: new Date(),
      },
    })

    await this.emailQueue
      .add('kyc-rejected', {
        to: owner.email,
        name: owner.name,
        data: { reason },
      }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })
      .catch((e: unknown) => this.logger.error('Email queue error', e))

    return { message: 'KYC rejected', ownerId, reason }
  }

  async getOwnerPayouts(ownerId: string, page = 1) {
    const PAGE_SIZE = 20
    const skip = (page - 1) * PAGE_SIZE

    const [payouts, total] = await Promise.all([
      this.prisma.owner_payouts.findMany({
        where: { owner_id: ownerId },
        orderBy: { created_at: 'desc' },
        skip,
        take: PAGE_SIZE,
        include: {
          payment: {
            select: {
              booking: { select: { id: true, booking_name: true, booking_date: true, start_time: true } },
            },
          },
        }
      }),
      this.prisma.owner_payouts.count({ where: { owner_id: ownerId } })
    ])

    const data = payouts.map((payout: (typeof payouts)[number]) => ({
      ...payout,
      booking: payout.payment.booking,
    }))

    return { data, meta: { page, total } }
  }
}
