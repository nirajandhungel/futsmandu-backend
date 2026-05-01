import { Injectable, Logger } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { QUEUE_AUDIT_LOGS } from '@futsmandu/queues'
import type { action_type, actor_type } from '@futsmandu/database'

export interface AuditLogParams {
  actorType: actor_type
  actorId: string
  action: action_type
  targetType?: string
  targetId?: string
  metadata?: Record<string, any>
}

export interface AdminAuditParams {
  adminId: string
  action: string
  targetId?: string
  targetType?: string
  metadata?: Record<string, any>
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name)

  constructor(
    @InjectQueue(QUEUE_AUDIT_LOGS) private readonly auditQueue: Queue,
  ) {}

  /**
   * Log a general user, owner, or system activity.
   */
  async log(params: AuditLogParams) {
    try {
      await this.auditQueue.add('write', {
        activity: {
          actor_type: params.actorType,
          actor_id: params.actorId,
          action: params.action,
          target_type: params.targetType ?? null,
          target_id: params.targetId,
          metadata: params.metadata ?? {},
        },
      }, {
        removeOnComplete: 1000,
        removeOnFail: 2000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      })
    } catch (err) {
      this.logger.error(`Failed to enqueue activity log: ${String(err)}`)
    }
  }

  /**
   * Log a sensitive admin operation to the dedicated admin audit trail.
   * Also records a shadow entry in the general activity log for unification.
   */
  async logAdminAction(params: AdminAuditParams) {
    try {
      await this.auditQueue.add('write', {
        adminAudit: {
          adminId: params.adminId,
          action: params.action,
          targetId: params.targetId,
          targetType: params.targetType,
          metadata: params.metadata ?? {},
        },
        activity: {
          actor_type: 'ADMIN',
          actor_id: params.adminId,
          action: 'UPDATE', // Standard action_type for general activity log
          target_type: params.targetType ?? 'ADMIN_ACTION',
          target_id: params.targetId,
          metadata: {
            admin_action: params.action,
            ...params.metadata,
          },
        },
      }, {
        removeOnComplete: 2000,
        removeOnFail: 5000,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      })
    } catch (err) {
      this.logger.error(`Failed to enqueue admin audit log: ${String(err)}`)
    }
  }
}
