// apps/player-api/src/workers/processors/sms.processor.ts
// FIX: Extracted from refund.processor.ts where it lived with aliased NestJS decorators.
// FIX: Added AbortSignal timeout — Sparrow SMS call had no timeout, could hang indefinitely.

import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import type { SmsJobData } from '@futsmandu/types'
import { ENV } from '@futsmandu/utils'

const GATEWAY_TIMEOUT_MS = 10_000

@Processor('sms')
export class SmsProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsProcessor.name)

  async process(job: Job<SmsJobData>): Promise<void> {
    const { phone, message } = job.data

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS)

    let res: Response
    try {
      res = await fetch('https://api.sparrowsms.com/v2/sms/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: ENV['SPARROW_SMS_TOKEN'],
          from: 'Futsmandu',
          to: phone,
          text: message,
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      throw new Error(`Sparrow SMS failed: ${res.status} ${await res.text()}`)
    }
    this.logger.log(`SMS sent to ${phone}`, { jobId: job.id })
  }
}
