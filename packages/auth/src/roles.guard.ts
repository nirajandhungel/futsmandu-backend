import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { FastifyRequest } from 'fastify'
import { ROLES_KEY } from './roles.decorator.js'

type RequestWithUser = FastifyRequest & { user?: unknown }

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])

    if (!requiredRoles || requiredRoles.length === 0) return true

    const request = context.switchToHttp().getRequest<RequestWithUser>()
    const user = request.user as { role?: unknown } | undefined
    const role = user?.role

    if (typeof role !== 'string') {
      throw new ForbiddenException('Forbidden')
    }

    if (!requiredRoles.includes(role)) {
      throw new ForbiddenException('Insufficient role')
    }

    return true
  }
}

