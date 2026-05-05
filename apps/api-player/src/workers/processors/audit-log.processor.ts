import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { QUEUE_AUDIT_LOGS } from '@futsmandu/queues'

type AuditWriteJob = {
  activity: {
    actor_type: 'ADMIN' | 'OWNER' | 'USER' | 'SYSTEM'
    actor_id: string
    action: 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT' | 'PAYMENT' | 'REFUND' | 'JOIN_MATCH' | 'LEAVE_MATCH' | 'INVITE' | 'REPORT'
    target_type: string | null
    target_id?: string
    metadata?: Record<string, unknown>
  }
}

@Injectable()
@Processor(QUEUE_AUDIT_LOGS, { concurrency: 20 })
export class AuditLogProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditLogProcessor.name)

  constructor(private readonly prisma: PrismaService) {
    super()
  }

  async process(job: Job<AuditWriteJob>): Promise<void> {
    const { activity } = job.data

    if (!activity) return;

    await this.prisma.user_activity_log.create({
      data: {
        actor_type: activity.actor_type,
        actor_id: activity.actor_id,
        action: activity.action as any,
        target_type: activity.target_type ?? undefined,
        target_id: activity.target_id,
        metadata: (activity.metadata ?? {}) as any,
      },
    }).catch((err: unknown) => {
      this.logger.error(`Failed to persist activity log for job ${job.id}`, String(err))
    })
  }
}
