// Staff management — invite, update roles, deactivate.
// Staff accounts use the owners table; parentOwnerId stored in verification_docs.
// OWNER_ADMIN can do everything; OWNER_STAFF has limited permissions.
import {
  Injectable, ConflictException, NotFoundException,
  ForbiddenException, Logger,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PrismaService } from '@futsmandu/database'
import * as bcrypt from 'bcryptjs'
import type { InviteStaffDto, UpdateStaffRoleDto } from './dto/staff.dto.js'

type StaffMeta = { parentOwnerId: string; role: string }

@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt:    JwtService,
  ) {}

  async listStaff(ownerId: string) {
    // Use Prisma JSON path filter to find staff by parentOwnerId
    const all = await this.prisma.owners.findMany({
      where: {
        is_active:          true,
        verification_docs:  { path: ['parentOwnerId'], equals: ownerId },
      },
      select: {
        id: true, name: true, email: true, phone: true,
        is_active: true, verification_docs: true, created_at: true,
      },
    })

    return all.map((o: any) => {
      const meta = o.verification_docs as StaffMeta
      return {
        id:         o.id,
        name:       o.name,
        email:      o.email,
        phone:      o.phone,
        role:       meta.role,
        is_active:  o.is_active,
        created_at: o.created_at,
      }
    })
  }

  async inviteStaff(ownerId: string, dto: InviteStaffDto) {
    const existing = await this.prisma.owners.findFirst({
      where:  { OR: [{ email: dto.email }, { phone: dto.phone }] },
      select: { email: true },
    })
    if (existing) throw new ConflictException('Email or phone already in use')

    const password_hash = await bcrypt.hash(dto.password, 12)
    const staffMeta: StaffMeta = { parentOwnerId: ownerId, role: dto.role }

    const staff = await this.prisma.owners.create({
      data: {
        name:              dto.name,
        email:             dto.email,
        phone:             dto.phone,
        password_hash,
        is_verified:       true, // staff are pre-verified by the owner
        verification_docs: staffMeta,
      },
      select: { id: true, name: true, email: true, phone: true, created_at: true },
    })

    this.logger.log(`Staff ${staff.email} invited to owner account ${ownerId}`)
    return { ...staff, role: dto.role }
  }

  async updateRole(ownerId: string, staffId: string, dto: UpdateStaffRoleDto) {
    const staff = await this.assertStaffOwnership(staffId, ownerId)
    const currentMeta = staff.verification_docs as StaffMeta

    await this.prisma.owners.update({
      where: { id: staffId },
      data: {
        verification_docs: { ...currentMeta, role: dto.role },
        updated_at: new Date(),
      },
    })
    return { id: staffId, role: dto.role, message: 'Role updated' }
  }

  async deactivateStaff(ownerId: string, staffId: string) {
    await this.assertStaffOwnership(staffId, ownerId)
    await this.prisma.owners.update({
      where: { id: staffId },
      data:  { is_active: false, updated_at: new Date() },
    })
    return { message: 'Staff deactivated' }
  }

  private async assertStaffOwnership(staffId: string, ownerId: string) {
    const staff = await this.prisma.owners.findUnique({
      where:  { id: staffId },
      select: { id: true, verification_docs: true },
    })
    if (!staff) throw new NotFoundException('Staff member not found')

    const meta = staff.verification_docs as StaffMeta | null
    if (meta?.parentOwnerId !== ownerId) {
      throw new ForbiddenException('Cannot manage staff outside your account')
    }
    return staff
  }
}
