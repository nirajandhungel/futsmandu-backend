// CHANGED: [L-2, H-4 — added calculatePriceFromRules(rules[], date, startTime) overload]
// NEW ISSUES FOUND:
//   - calculatePrice fetched rules inside the function; no way to reuse across loop iterations
//   - getCalendar in owner bookings called calculatePrice per slot (N+1): fix is to call
//     calculatePriceFromRules with pre-fetched rules instead

// packages/utils/src/pricing-engine.ts
// Dynamic pricing engine — evaluates rules highest-priority-first.
// Rule types: base(1) < offpeak(5) < weekend(8) < peak(10) < lastminute(15) < custom(20)
// All prices in PAISA (NPR × 100). Never use floating point for money.

import type { PricingResult } from '@futsmandu/types'

// Break circular dependency by using any for TxClient since it only needs pricing_rules.findMany
type TxClient = any;

// Minimal type matching what Prisma returns for pricing_rules
export interface PricingRule {
  id: string
  rule_type: string
  priority: number
  price: number
  modifier: string
  days_of_week: number[]
  start_time: string | null
  end_time: string | null
  date_from: Date | null
  date_to: Date | null
  hours_before: number | null
  is_active: boolean
}

/**
 * calculatePriceFromRules — pure function, no DB access.
 * H-4: Call this inside calendar loops after fetching all rules ONCE.
 * L-2: Overload that accepts pre-fetched rules array.
 */
export function calculatePriceFromRules(
  rules: PricingRule[],
  date: string,
  startTime: string,
): PricingResult {
  const activeRules = rules
    .filter(r => r.is_active)
    .sort((a, b) => b.priority - a.priority)

  if (activeRules.length === 0) throw new Error('No active pricing rules')

  const slotDate = new Date(date)
  const dayOfWeek = slotDate.getDay()
  const now = new Date()
  const slotDt = new Date(`${date}T${startTime}:00+05:45`)
  const hoursUntil = (slotDt.getTime() - now.getTime()) / 3_600_000

  for (const rule of activeRules) {
    let match = true

    if (rule.days_of_week.length > 0 && !rule.days_of_week.includes(dayOfWeek)) match = false
    if (rule.start_time && rule.end_time && (startTime < rule.start_time || startTime >= rule.end_time)) match = false
    if (rule.date_from && rule.date_to) {
      if (slotDate < new Date(rule.date_from) || slotDate > new Date(rule.date_to)) match = false
    }
    if (rule.rule_type === 'lastminute' && rule.hours_before !== null && hoursUntil > (rule.hours_before ?? 0)) match = false
    if (!match) continue

    if (rule.modifier === 'fixed') return { price: rule.price, ruleId: rule.id, ruleType: rule.rule_type }

    const baseRule = activeRules.find(r => r.rule_type === 'base')
    if (!baseRule) throw new Error('Base pricing rule missing')

    if (rule.modifier === 'percent_add') {
      return { price: Math.round(baseRule.price * (1 + rule.price / 100)), ruleId: rule.id, ruleType: rule.rule_type }
    }
    if (rule.modifier === 'percent_off') {
      return { price: Math.round(baseRule.price * (1 - rule.price / 100)), ruleId: rule.id, ruleType: rule.rule_type }
    }
  }

  throw new Error('No matching pricing rule')
}

/**
 * calculatePrice — DB-fetching version. Used inside Prisma transactions.
 * For loops, prefer fetchRulesForCourt + calculatePriceFromRules to avoid N+1.
 */
export async function calculatePrice(
  tx: TxClient,
  courtId: string,
  date: string,
  startTime: string,
): Promise<PricingResult> {
  const rules = await tx.pricing_rules.findMany({
    where: { court_id: courtId, is_active: true },
    orderBy: { priority: 'desc' },
  })

  if (rules.length === 0) throw new Error(`No pricing rules for court ${courtId}`)

  return calculatePriceFromRules(rules as PricingRule[], date, startTime)
}
