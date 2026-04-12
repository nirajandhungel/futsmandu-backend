import {
    Injectable, CanActivate, ExecutionContext,
    UnauthorizedException, SetMetadata,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import type { FastifyRequest } from 'fastify'
import { ENV } from '@futsmandu/utils'

export const IS_PUBLIC_KEY = 'isOwnerPublic'
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)

export interface AuthOwner {
    id: string
    email: string
    role: string
    venue_id?: string
}

interface OwnerJwtPayload {
    sub: string
    email: string
    type: 'access' | 'refresh'
    role: string
    venueId?: string
    iat?: number
    exp?: number
}

@Injectable()
export class OwnerJwtGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly jwt: JwtService,
    ) { }

    canActivate(ctx: ExecutionContext): boolean {
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            ctx.getHandler(),
            ctx.getClass(),
        ])
        if (isPublic) return true

        const request = ctx.switchToHttp().getRequest<FastifyRequest & { owner: AuthOwner }>()
        const token = this.extractToken(request)
        if (!token) throw new UnauthorizedException('Missing owner access token')

        let payload: OwnerJwtPayload
        try {
            payload = this.jwt.verify<OwnerJwtPayload>(token, {
                secret: ENV['OWNER_JWT_SECRET'],
            })
        } catch {
            throw new UnauthorizedException('Invalid or expired owner token')
        }

        if (payload.type !== 'access') throw new UnauthorizedException('Invalid token type')

        request.owner = {
            id: payload.sub,
            email: payload.email,
            role: payload.role,
            venue_id: payload.venueId,
        }

        return true
    }

    private extractToken(req: FastifyRequest): string | null {
        const auth = req.headers.authorization
        if (auth?.startsWith('Bearer ')) return auth.slice(7)
        const cookie = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.['owner_token']
        if (cookie) return cookie
        return null
    }
}
