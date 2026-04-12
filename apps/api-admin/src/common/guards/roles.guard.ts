import { Injectable, CanActivate, ExecutionContext, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { FastifyRequest } from 'fastify'

export const Roles = (...roles: string[]) => SetMetadata('roles', roles)

@Injectable()
export class RolesGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) { }

    canActivate(context: ExecutionContext): boolean {
        const requiredRoles = this.reflector.getAllAndOverride<string[]>('roles', [
            context.getHandler(),
            context.getClass(),
        ])
        if (!requiredRoles) {
            return true
        }
        const request = context.switchToHttp().getRequest<FastifyRequest & { admin?: any }>()
        const user = request.admin
        if (!user || !user.role) return false
        return requiredRoles.includes(user.role)
    }
}
