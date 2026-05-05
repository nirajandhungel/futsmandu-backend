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

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name)

  constructor(
    @InjectQueue(QUEUE_AUDIT_LOGS) private readonly auditQueue: Queue,
  ) {}

  /**
   * Log a user, owner, admin or system activity to the unified user_activity_log.
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
}
