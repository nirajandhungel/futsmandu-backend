import { Injectable } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { RedisService } from '@futsmandu/redis'
import { InjectQueue } from '@nestjs/bullmq'
import type { Queue } from 'bullmq'
import { QUEUE_SECURITY_INCIDENTS } from '@futsmandu/queues'
import { BaseAbuseDetectionGuard } from '@futsmandu/security'

@Injectable()
export class AbuseDetectionGuard extends BaseAbuseDetectionGuard {
  constructor(
    redis: RedisService,
    @InjectQueue(QUEUE_SECURITY_INCIDENTS) securityQueue: Queue,
  ) {
    super(redis, securityQueue, {
      namespace: 'admin',
      actorType: 'ADMIN',
      actorRole: 'ADMIN',
      maxRequestsPerWindow: 45,
      windowSeconds: 20,
    })
  }

  protected getActorId(req: FastifyRequest): string | undefined {
    return (req as FastifyRequest & { admin?: { id: string } }).admin?.id
  }
}
