import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { AuthOwner } from '../guards/owner-jwt.guard.js'

export const CurrentOwner = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthOwner => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { owner: AuthOwner }>()
    return req.owner
  },
)
