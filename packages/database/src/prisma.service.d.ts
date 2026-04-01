import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma';
export declare class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger;
    constructor();
    onModuleInit(): Promise<void>;
    onModuleDestroy(): Promise<void>;
    /**
     * S-6: Health check with 2s timeout so a slow DB does not hang the probe.
     * Uses Promise.race to enforce the deadline without holding a connection open.
     */
    isHealthy(): Promise<boolean>;
}
//# sourceMappingURL=prisma.service.d.ts.map