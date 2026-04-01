// packages/utils/src/helpers.ts
import { randomBytes } from 'crypto'

/** Add minutes to an HH:MM time string → returns HH:MM */
export function addMinutesToTime(timeStr: string, minutes: number): string {
  const [h, m] = timeStr.split(':').map(Number) as [number, number]
  const total = h * 60 + m + minutes
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Haversine distance in km */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** 120000 paisa → "NPR 1,200" */
export function formatPaisa(paisa: number): string {
  return `NPR ${(paisa / 100).toLocaleString('en-NP')}`
}

/** Generate a cryptographically random hex token */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('hex')
}

/** Nepal timezone offset string for Date construction */
export const NEPAL_TZ_OFFSET = '+05:45'

/** Build a Nepal-local Date from a booking_date and start_time */
export function nepalDateTime(date: Date, startTime: string): Date {
  const dateStr = date.toISOString().split('T')[0]
  return new Date(`${dateStr}T${startTime}:00${NEPAL_TZ_OFFSET}`)
}

/** Hours until a Nepal slot start time from now */
export function hoursUntilSlot(date: Date, startTime: string): number {
  return (nepalDateTime(date, startTime).getTime() - Date.now()) / 3_600_000
}
