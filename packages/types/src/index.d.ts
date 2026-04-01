export interface JwtPayload {
    sub: string;
    email: string;
    type: 'access' | 'refresh' | 'password-reset' | 'email-verify';
    iat?: number;
    exp?: number;
}
export interface AuthenticatedUser {
    id: string;
    email: string;
}
export interface CursorPage<T> {
    data: T[];
    meta: {
        nextCursor: string | null;
        limit: number;
    };
}
export interface OffsetPage<T> {
    data: T[];
    meta: {
        page: number;
        limit: number;
        total?: number;
    };
}
export interface ApiSuccess<T> {
    data: T;
    meta?: Record<string, unknown>;
}
export interface ApiError {
    error: string;
    code: string;
    statusCode: number;
    details?: unknown;
}
export interface GatewayVerification {
    success: boolean;
    amount: number;
    txId: string;
    raw: Record<string, unknown>;
}
export interface KhaltiInitResult {
    paymentUrl: string;
    pidx: string;
}
export interface EsewaInitResult {
    signedPayload: Record<string, string | number>;
    esewaUrl: string;
}
export interface SlotGridItem {
    startTime: string;
    endTime: string;
    status: 'AVAILABLE' | 'HELD' | 'PENDING_PAYMENT' | 'CONFIRMED';
    price?: number;
    displayPrice?: string;
}
export interface PricingResult {
    price: number;
    ruleId: string | null;
    ruleType: string;
}
export type FeedType = 'tonight' | 'tomorrow' | 'weekend';
export interface MatchOpportunity {
    matchGroupId: string;
    venueId: string;
    venueName: string;
    venueCoverUrl: string | null;
    matchDate: Date;
    startTime: string;
    skillFilter: string | null;
    spotsLeft: number;
    memberUserIds: string[];
    venueLat: number;
    venueLng: number;
}
export interface ScoredMatch extends MatchOpportunity {
    score: number;
}
export interface NotificationPayload {
    title: string;
    body: string;
    data?: Record<string, string>;
    sendSms: boolean;
}
export interface NotificationJobData {
    type: string;
    userId: string;
    data: Record<string, unknown>;
}
export interface RefundJobData {
    bookingId: string;
    refundAmount: number;
}
export interface SlotExpiryJobData {
    bookingId: string;
}
export interface EmailJobData {
    type: 'verification-email' | 'password-reset' | 'booking-confirmation' | 'booking-cancelled';
    to: string;
    name?: string;
    data?: Record<string, unknown>;
}
export interface SmsJobData {
    phone: string;
    message: string;
}
export interface StatsJobData {
    matchGroupId: string;
    winner: 'A' | 'B' | 'draw';
}
//# sourceMappingURL=index.d.ts.map