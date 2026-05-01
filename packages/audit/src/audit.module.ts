import { Module, Global } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { QUEUE_AUDIT_LOGS } from '@futsmandu/queues'
import { AuditService } from './audit.service.js'

@Global()
@Module({
  imports: [
    BullModule.registerQueue({
      name: QUEUE_AUDIT_LOGS,
    }),
  ],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
