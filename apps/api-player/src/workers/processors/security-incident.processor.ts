import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
import { Injectable, Logger } from '@nestjs/common'
import { PrismaService, Prisma } from '@futsmandu/database'
import { QUEUE_SECURITY_INCIDENTS } from '@futsmandu/queues'

type SecurityIncidentJob = {
  actorType: 'ADMIN' | 'OWNER' | 'USER' | 'SYSTEM'
  actorId: string
  actorRole: string
  incidentType: string
  severity: 'LOW' | 'MEDIUM' | 'HIGH'
  level: number
  riskScore: number
  requestCount?: number
  ipAddress?: string | null
  userAgent?: string | null
  endpoint?: string | null
  method?: string | null
  scopeKey: string
  cooldownUntil?: string | null
  metadata?: Record<string, unknown>
}

@Injectable()
@Processor(QUEUE_SECURITY_INCIDENTS, { concurrency: 20 })
export class SecurityIncidentProcessor extends WorkerHost {
  private readonly logger = new Logger(SecurityIncidentProcessor.name)

  constructor(private readonly prisma: PrismaService) {
    super()
  }

  async process(job: Job<SecurityIncidentJob>): Promise<void> {
    const d = job.data
    await this.prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO security_incidents (
          actor_type, actor_id, actor_role, incident_type, severity, level, risk_score, request_count,
          ip_address, user_agent, endpoint, method, scope_key, cooldown_until, metadata
        ) VALUES (
          ${d.actorType}::actor_type,
          ${d.actorId}::uuid,
          ${d.actorRole},
          ${d.incidentType},
          ${d.severity},
          ${d.level},
          ${d.riskScore},
          ${d.requestCount ?? null},
          ${d.ipAddress ?? null},
          ${d.userAgent ?? null},
          ${d.endpoint ?? null},
          ${d.method ?? null},
          ${d.scopeKey},
          ${d.cooldownUntil ? new Date(d.cooldownUntil) : null},
          ${JSON.stringify(d.metadata ?? {})}::jsonb
        )
      `,
    ).catch((err: unknown) => {
      this.logger.error(`Failed to persist security incident for job ${job.id}`, String(err))
    })
  }
}
