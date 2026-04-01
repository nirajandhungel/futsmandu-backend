import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
export declare const IS_PUBLIC_KEY = "isPublic";
/** Mark a route as public — skip JWT auth */
export declare const Public: () => import("@nestjs/common").CustomDecorator<string>;
declare const JwtAuthGuard_base: import("@nestjs/passport").Type<import("@nestjs/passport").IAuthGuard>;
/** Standard JWT guard. Use @Public() to skip. */
export declare class JwtAuthGuard extends JwtAuthGuard_base {
    private readonly reflector;
    constructor(reflector: Reflector);
    canActivate(ctx: ExecutionContext): boolean | Promise<boolean> | import("rxjs").Observable<boolean>;
    handleRequest<T>(err: Error | null, user: T): T;
}
/** @CurrentUser() — injects the authenticated user from request */
export declare const CurrentUser: (...dataOrPipes: unknown[]) => ParameterDecorator;
export {};
//# sourceMappingURL=guards.d.ts.map