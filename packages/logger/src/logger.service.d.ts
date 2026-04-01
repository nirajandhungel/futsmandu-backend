import { LoggerService } from '@nestjs/common';
export declare class AppLogger implements LoggerService {
    private readonly logger;
    constructor(context?: string);
    setContext(context: string): void;
    log(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, trace?: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
    verbose(message: string, meta?: Record<string, unknown>): void;
    private format;
}
//# sourceMappingURL=logger.service.d.ts.map