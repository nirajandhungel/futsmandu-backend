// apps/admin-api/src/common/guards/admin-jwt.guard.ts
// Validates Bearer tokens signed with ADMIN_JWT_SECRET (8h sessions).
// Also accepts admin token from HTTP-only cookie (for browser dashboard).
// NEVER shares secret with owner-api or player-api.
import {
  Injectable, CanActivate, ExecutionContext,
  UnauthorizedException, SetMetadata, ForbiddenException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import type { FastifyRequest } from 'fastify'
import { ENV } from '@futsmandu/utils'

export const IS_PUBLIC_KEY = 'isAdminPublic'
export const AdminPublic   = () => SetMetadata(IS_PUBLIC_KEY, true)

// Required roles decorator for super-admin-only operations
export const ADMIN_ROLE_KEY = 'requiredAdminRole'
export const RequireRole    = (role: 'ADMIN' | 'SUPER_ADMIN') => SetMetadata(ADMIN_ROLE_KEY, role)

export interface AuthAdmin {
  id:    string
  email: string
  role:  string
}

interface AdminJwtPayload {
  sub:   string
  email: string
  type:  'access' | 'refresh'
  role:  string
  iat?:  number
  exp?:  number
}

@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (isPublic) return true

    const request = ctx.switchToHttp().getRequest<FastifyRequest & { admin: AuthAdmin }>()
    const token   = this.extractToken(request)
    if (!token) throw new UnauthorizedException('Missing admin access token')

    let payload: AdminJwtPayload
    try {
      payload = this.jwt.verify<AdminJwtPayload>(token, {
        secret: ENV['ADMIN_JWT_SECRET'],
      })
    } catch {
      throw new UnauthorizedException('Invalid or expired admin token')
    }

    if (payload.type !== 'access') throw new UnauthorizedException('Invalid token type')

    const validRoles = ['ADMIN', 'SUPER_ADMIN']
    if (!validRoles.includes(payload.role)) {
      throw new ForbiddenException('Not an admin account')
    }

    request.admin = {
      id:    payload.sub,
      email: payload.email,
      role:  payload.role,
    }

    // Check required role if specified
    const requiredRole = this.reflector.getAllAndOverride<string>(ADMIN_ROLE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (requiredRole === 'SUPER_ADMIN' && payload.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('SUPER_ADMIN role required')
    }

    return true
  }

  private extractToken(req: FastifyRequest): string | null {
    // 1. Bearer header (preferred for API clients)
    const auth = req.headers.authorization
    if (auth?.startsWith('Bearer ')) return auth.slice(7)

    // 2. HTTP-only cookie (browser dashboard)
    const cookie = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.['admin_token']
    if (cookie) return cookie

    return null
  }
}
