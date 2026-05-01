export const QUEUE_NOTIFICATIONS = 'notifications' as const
export const QUEUE_PAYMENT_RECON = 'payment-recon' as const
export const QUEUE_REFUNDS = 'refunds' as const
export const QUEUE_PLAYER_STATS = 'player-stats' as const
export const QUEUE_PLAYER_EMAILS = 'player-emails' as const
export const QUEUE_SMS = 'sms' as const
export const QUEUE_SLOT_EXPIRY = 'slot-expiry' as const
export const QUEUE_ANALYTICS = 'analytics' as const
export const QUEUE_IMAGE_PROCESSING = 'image-processing' as const
export const QUEUE_OWNER_EMAILS = 'owner-emails' as const
export const QUEUE_ADMIN_EMAILS = 'admin-emails' as const
export const QUEUE_ADMIN_ALERTS = 'admin-alerts' as const
export const QUEUE_OWNER_PAYOUTS = 'owner-payouts' as const
export const QUEUE_PAYOUT_RETRY = 'payout-retry' as const
export const QUEUE_MEDIA_ORPHAN_CLEANUP = 'media-orphan-cleanup' as const
export const QUEUE_AUDIT_LOGS = 'audit-logs' as const
export const QUEUE_SECURITY_INCIDENTS = 'security-incidents' as const

export const ALL_QUEUE_NAMES = [
  QUEUE_NOTIFICATIONS,
  QUEUE_PAYMENT_RECON,
  QUEUE_REFUNDS,
  QUEUE_PLAYER_STATS,
  QUEUE_PLAYER_EMAILS,
  QUEUE_SMS,
  QUEUE_SLOT_EXPIRY,
  QUEUE_ANALYTICS,
  QUEUE_IMAGE_PROCESSING,
  QUEUE_OWNER_EMAILS,
  QUEUE_ADMIN_EMAILS,
  QUEUE_ADMIN_ALERTS,
  QUEUE_OWNER_PAYOUTS,
  QUEUE_PAYOUT_RETRY,
  QUEUE_MEDIA_ORPHAN_CLEANUP,
  QUEUE_AUDIT_LOGS,
  QUEUE_SECURITY_INCIDENTS,
] as const

export type QueueName = (typeof ALL_QUEUE_NAMES)[number]

