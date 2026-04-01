// apps/owner-api/src/workers/processors/sms.processor.ts
// SMS processor for owner-api — Sparrow SMS Nepal.
// Sends booking alerts and verification status updates to owner phone.
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { ENV } from '@futsmandu/utils'

interface SmsJobData {
  phone: string
  message: string
}

@Processor('sms')
export class OwnerSmsProcessor extends WorkerHost {
  private readonly logger = new Logger(OwnerSmsProcessor.name)

  async process(job: Job<SmsJobData>): Promise<void> {
    if (job.name !== 'send-sms') return
    const { phone, message } = job.data

    const token = ENV['SPARROW_SMS_TOKEN']
    if (!token) {
      this.logger.warn('SPARROW_SMS_TOKEN not set — owner SMS not sent')
      return
    }

    const res = await fetch('https://api.sparrowsms.com/v2/sms/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        from: 'Futsmandu',
        to:   phone,
        text: message.slice(0, 160), // SMS 160 char limit
      }),
    })

    if (!res.ok) {
      throw new Error(`Sparrow SMS failed: ${res.status} ${await res.text()}`)
    }

    this.logger.log(`Owner SMS sent to ${phone}`, { jobId: job.id })
  }
}
