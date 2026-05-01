import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import type { FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import type { Queue } from 'bullmq'
import { RedisService } from '@futsmandu/redis'
import { QUEUE_SECURITY_INCIDENTS } from '@futsmandu/queues'

const RISK_TTL_SECONDS = 3600
const REVIEW_TTL_SECONDS = 24 * 3600

export type SecurityActorType = 'ADMIN' | 'OWNER' | 'USER'

export interface AbuseGuardConfig {
  namespace: 'admin' | 'owner' | 'player'
  actorType: SecurityActorType
  actorRole: string
  maxRequestsPerWindow: number
  windowSeconds: number
}

@Injectable()
export abstract class BaseAbuseDetectionGuard implements CanActivate {
  private readonly logger = new Logger(this.constructor.name)

  constructor(
    private readonly redis: RedisService,
    @InjectQueue(QUEUE_SECURITY_INCIDENTS) private readonly securityQueue: Queue,
    private readonly config: AbuseGuardConfig,
  ) {}

  protected abstract getActorId(req: FastifyRequest): string | undefined

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>()
    const method = req.method?.toUpperCase() ?? 'GET'
    const url = req.url ?? ''
    if (method === 'OPTIONS' || url.includes('/health') || url.includes('/api/docs')) return true

    const actorId = this.getActorId(req)
    const scope = this.resolveScopeKey(req, actorId)
    const cooldownTtl = await this.readCooldownTtl(scope)
    if (cooldownTtl > 0) {
      throw new HttpException(
        `Too many requests. Temporary cooldown active for ${cooldownTtl} seconds.`,
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }

    const key = `abuse:${this.config.namespace}:${scope}:${Math.floor(Date.now() / (this.config.windowSeconds * 1000))}`

    let count = 0
    try {
      count = await this.redis.client.incr(key)
      if (count === 1) {
        await this.redis.client.expire(key, this.config.windowSeconds + 5)
      }
    } catch (err) {
      this.logger.warn(`Redis abuse counter failed: ${String(err)}`)
      return true
    }

    if (count <= this.config.maxRequestsPerWindow) return true

    const riskDelta = this.riskDelta(count)
    const riskScore = await this.bumpRiskScore(scope, riskDelta)
    const level = this.resolveLevel(riskScore)
    const cooldownSeconds = this.resolveCooldownSeconds(level)
    if (cooldownSeconds > 0) await this.setCooldown(scope, cooldownSeconds)
    if (level >= 4) await this.setReviewFlag(scope)

    await this.enqueueSecurityIncident({
      actorType: this.config.actorType,
      actorId: actorId ?? '00000000-0000-0000-0000-000000000000',
      actorRole: this.config.actorRole,
      scopeKey: scope,
      level,
      riskScore,
      requestCount: count,
      cooldownSeconds,
      req,
    })

    this.logger.warn(
      `${this.config.actorRole} abuse level ${level} detected for ${scope} (count=${count}, risk=${riskScore})`,
    )

    throw new HttpException(
      'Suspicious traffic detected. Request temporarily blocked.',
      HttpStatus.TOO_MANY_REQUESTS,
    )
  }

  private resolveScopeKey(req: FastifyRequest, actorId?: string): string {
    if (actorId) return `${this.config.namespace}:${actorId}`
    const ip = req.ip ?? 'unknown'
    const ua = String(req.headers['user-agent'] ?? 'unknown')
    const fingerprint = createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 16)
    return `anon:${fingerprint}`
  }

  private async readCooldownTtl(scope: string): Promise<number> {
    const key = `abuse:${this.config.namespace}:cooldown:${scope}`
    try {
      const ttl = await this.redis.client.ttl(key)
      return ttl > 0 ? ttl : 0
    } catch {
      return 0
    }
  }

  private riskDelta(count: number): number {
    if (count >= this.config.maxRequestsPerWindow * 2) return 35
    if (count >= Math.floor(this.config.maxRequestsPerWindow * 1.5)) return 20
    return 10
  }

  private async bumpRiskScore(scope: string, delta: number): Promise<number> {
    const key = `abuse:${this.config.namespace}:risk:${scope}`
    const score = await this.redis.client.incrby(key, delta)
    await this.redis.client.expire(key, RISK_TTL_SECONDS)
    return score
  }

  private resolveLevel(riskScore: number): 1 | 2 | 3 | 4 | 5 {
    if (riskScore < 30) return 1
    if (riskScore < 60) return 2
    if (riskScore < 100) return 3
    if (riskScore < 160) return 4
    return 5
  }

  private resolveCooldownSeconds(level: number): number {
    if (level <= 1) return 0
    if (level === 2) return 60
    if (level === 3) return 5 * 60
    if (level === 4) return 15 * 60
    return 30 * 60
  }

  private async setCooldown(scope: string, seconds: number): Promise<void> {
    const key = `abuse:${this.config.namespace}:cooldown:${scope}`
    await this.redis.client.set(key, '1', 'EX', seconds)
  }

  private async setReviewFlag(scope: string): Promise<void> {
    const key = `abuse:${this.config.namespace}:review:${scope}`
    await this.redis.client.set(key, '1', 'EX', REVIEW_TTL_SECONDS)
  }

  private async enqueueSecurityIncident(params: {
    actorType: SecurityActorType
    actorId: string
    actorRole: string
    scopeKey: string
    level: number
    riskScore: number
    requestCount: number
    cooldownSeconds: number
    req: FastifyRequest
  }): Promise<void> {
    const now = Date.now()
    await this.securityQueue.add('record', {
      actorType: params.actorType,
      actorId: params.actorId,
      actorRole: params.actorRole,
      incidentType: 'BURST_REQUEST_TRAFFIC',
      severity: params.level >= 4 ? 'HIGH' : params.level >= 3 ? 'MEDIUM' : 'LOW',
      level: params.level,
      riskScore: params.riskScore,
      requestCount: params.requestCount,
      ipAddress: params.req.ip ?? null,
      userAgent: String(params.req.headers['user-agent'] ?? ''),
      endpoint: params.req.url ?? null,
      method: params.req.method ?? null,
      scopeKey: params.scopeKey,
      cooldownUntil: params.cooldownSeconds > 0 ? new Date(now + params.cooldownSeconds * 1000).toISOString() : null,
      metadata: {
        autoAction: params.level <= 1 ? 'LOG_ONLY' : 'COOLDOWN_ONLY',
        manualReviewRequired: params.level >= 4,
      },
    }, {
      removeOnComplete: 1000,
      removeOnFail: 2000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    }).catch((err: unknown) => this.logger.error('Failed to enqueue security incident', String(err)))
  }
}
