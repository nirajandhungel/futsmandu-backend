import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { AuthAdmin } from '../guards/admin-jwt.guard.js'

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthAdmin => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { admin: AuthAdmin }>()
    return req.admin
  },
)
