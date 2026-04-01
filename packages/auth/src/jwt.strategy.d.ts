import { Strategy } from 'passport-jwt';
import type { JwtPayload, AuthenticatedUser } from '@futsmandu/types';
declare const JwtStrategy_base: new (...args: [opt: import("passport-jwt").StrategyOptionsWithoutRequest] | [opt: import("passport-jwt").StrategyOptionsWithRequest]) => Strategy & {
    validate(...args: any[]): unknown;
};
export declare class JwtStrategy extends JwtStrategy_base {
    constructor(secret: string);
    validate(payload: JwtPayload): AuthenticatedUser;
}
export {};
//# sourceMappingURL=jwt.strategy.d.ts.map