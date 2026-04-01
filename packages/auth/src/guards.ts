// packages/auth/src/guards.ts
// JwtAuthGuard — used on all protected routes.
// BanGuard — checks Redis ban cache; DB fallback on cache miss.

import {
  Injectable, CanActivate, ExecutionContext,
  ForbiddenException, UnauthorizedException, SetMetadata,
  createParamDecorator,
} from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { Reflector } from '@nestjs/core'
import type { AuthenticatedUser } from '@futsmandu/types'

export const IS_PUBLIC_KEY = 'isPublic'
/** Mark a route as public — skip JWT auth */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)

/** Standard JWT guard. Use @Public() to skip. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) { super() }

  canActivate(ctx: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (isPublic) return true
    return super.canActivate(ctx)
  }

  handleRequest<T>(err: Error | null, user: T): T {
    if (err || !user) throw new UnauthorizedException('Invalid or expired token')
    return user
  }
}

// packages/auth/src/decorators.ts
import type { FastifyRequest } from 'fastify'

/** @CurrentUser() — injects the authenticated user from request */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest & { user: AuthenticatedUser }>()
    return request.user
  },
)
