import {
  Injectable, NotFoundException, ConflictException, BadRequestException, Logger,
} from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import type { pricing_modifier } from '@futsmandu/database'
import { calculatePrice, formatPaisa } from '@futsmandu/utils'
import type { CreatePricingRuleDto, UpdatePricingRuleDto } from './dto/pricing.dto.js'
import { DayOfWeek } from './dto/pricing.dto.js'

// Priority constants matching spec
const PRIORITY_MAP: Record<string, number> = {
  base: 1, offpeak: 5, weekend: 8, peak: 10, lastminute: 15, custom: 20,
}

// Maps string day abbreviations to PostgreSQL DOW integers (0 = Sun … 6 = Sat)
const DAY_MAP: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
}

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name)

  constructor(private readonly prisma: PrismaService) {}

  async listRules(ownerId: string, courtId: string) {
    await this.assertCourtOwnership(courtId, ownerId)
    return this.prisma.pricing_rules.findMany({
      where: { court_id: courtId },
      select: {
        id: true, rule_type: true, priority: true, price: true, modifier: true,
        days_of_week: true, start_time: true, end_time: true,
        date_from: true, date_to: true, hours_before: true, is_active: true, created_at: true,
      },
      orderBy: { priority: 'asc' },
    })
  }

  async createRule(ownerId: string, courtId: string, dto: CreatePricingRuleDto) {
    await this.assertCourtOwnership(courtId, ownerId)

    // Auto-derive priority for known rule types; only 'custom' needs an explicit value
    const canonicalPriority: number | undefined = PRIORITY_MAP[dto.rule_type]
    if (canonicalPriority === undefined && dto.priority === undefined) {
      throw new BadRequestException(
        `Rule type 'custom' requires an explicit priority (1–20)`,
      )
    }
    const priority = canonicalPriority ?? dto.priority!

    // Enforce a single mandatory base rule per court.
    if (dto.rule_type === 'base') {
      const existing = await this.prisma.pricing_rules.findFirst({
        where: { court_id: courtId, rule_type: 'base' },
        select: { id: true },
      })
      if (existing) throw new ConflictException('Court already has a base pricing rule')
    } else {
      const baseRule = await this.prisma.pricing_rules.findFirst({
        where: { court_id: courtId, rule_type: 'base', is_active: true },
        select: { id: true },
      })
      if (!baseRule) {
        throw new BadRequestException('Create a base pricing rule for this court before adding special pricing rules')
      }
    }

    return this.prisma.pricing_rules.create({
      data: {
        court_id:     courtId,
        rule_type:    dto.rule_type,
        priority,
        price:        dto.price,
        modifier:     dto.modifier as 'fixed' | 'percent_add' | 'percent_off',
        days_of_week: dto.days_of_week ? dto.days_of_week.map(d => DAY_MAP[d]) : [],
        start_time:   dto.start_time,
        end_time:     dto.end_time,
        date_from:    dto.date_from ? new Date(dto.date_from) : undefined,
        date_to:      dto.date_to   ? new Date(dto.date_to)   : undefined,
        hours_before: dto.hours_before,
      },
      select: { id: true, rule_type: true, priority: true, price: true, modifier: true },
    })
  }

  async updateRule(ownerId: string, ruleId: string, dto: UpdatePricingRuleDto) {
    await this.assertRuleOwnership(ruleId, ownerId)
    const { days_of_week, modifier, date_from, date_to, ...rest } = dto
    return this.prisma.pricing_rules.update({
      where: { id: ruleId },
      data: {
        ...rest,
        modifier:     modifier as pricing_modifier | undefined,
        days_of_week: days_of_week ? days_of_week.map(d => DAY_MAP[d]) : undefined,
        date_from:    date_from ? new Date(date_from) : undefined,
        date_to:      date_to   ? new Date(date_to)   : undefined,
      },
      select: { id: true, rule_type: true, price: true, is_active: true },
    })
  }

  async deleteRule(ownerId: string, ruleId: string) {
    const rule = await this.prisma.pricing_rules.findFirst({
      where: { id: ruleId, court: { venue: { owner_id: ownerId } } },
      select: { id: true, rule_type: true },
    })
    if (!rule) throw new NotFoundException('Pricing rule not found or access denied')
    if (rule.rule_type === 'base') {
      throw new BadRequestException('Cannot delete the base pricing rule')
    }
    await this.prisma.pricing_rules.delete({ where: { id: ruleId } })
    return { message: 'Pricing rule deleted' }
  }

  async preview(ownerId: string, courtId: string, date: string, time: string) {
    await this.assertCourtOwnership(courtId, ownerId)
    const result = await calculatePrice(this.prisma, courtId, date, time)
    return {
      price:       result.price,
      displayPrice: formatPaisa(result.price),
      ruleId:      result.ruleId,
      ruleType:    result.ruleType,
      date,
      time,
    }
  }

  private async assertCourtOwnership(courtId: string, ownerId: string): Promise<void> {
    const court = await this.prisma.courts.findFirst({
      where: { id: courtId, venue: { owner_id: ownerId } },
      select: { id: true },
    })
    if (!court) throw new NotFoundException('Court not found or access denied')
  }

  private async assertRuleOwnership(ruleId: string, ownerId: string): Promise<void> {
    const rule = await this.prisma.pricing_rules.findFirst({
      where: { id: ruleId, court: { venue: { owner_id: ownerId } } },
      select: { id: true },
    })
    if (!rule) throw new NotFoundException('Pricing rule not found or access denied')
  }
}
