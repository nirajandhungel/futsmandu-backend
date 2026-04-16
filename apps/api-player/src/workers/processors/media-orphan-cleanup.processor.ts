import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { ENV } from '@futsmandu/utils'

@Processor('media-orphan-cleanup')
export class MediaOrphanCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(MediaOrphanCleanupProcessor.name)
  private readonly s3Client: S3Client
  private readonly bucket: string

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {
    super()
    this.s3Client = new S3Client({
      endpoint: ENV['S3_ENDPOINT'] || '',
      region: ENV['S3_REGION'] || 'us-east-1',
      credentials: {
        accessKeyId: ENV['S3_ACCESS_KEY'] || '',
        secretAccessKey: ENV['S3_SECRET_KEY'] || '',
      },
      forcePathStyle: ENV['S3_FORCE_PATH_STYLE'] === 'true',
    })
    this.bucket = ENV['S3_BUCKET'] || ''
  }

  async process(): Promise<void> {
    const maxAgeHours = Number.isFinite(ENV['MEDIA_ORPHAN_MAX_AGE_HOURS']) 
      ? ENV['MEDIA_ORPHAN_MAX_AGE_HOURS'] 
      : 12  // Reduced from 24h to 12h for faster recovery
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000)
    const batchSize = 500

    this.logger.log(`Scanning for orphan media uploads (status = processing, age > ${maxAgeHours}h)`)

    let totalProcessed = 0
    let totalDeleted = 0
    let totalFailed = 0
    let hasMore = true

    while (hasMore) {
      const orphans = await this.prisma.media_assets.findMany({
        where: {
          status: 'processing',
          updated_at: { lt: cutoff },
        },
        select: {
          id: true,
          file_key: true,
        },
        take: batchSize,
        orderBy: { updated_at: 'asc' },
      })

      if (orphans.length === 0) {
        hasMore = false
        break
      }

      totalProcessed += orphans.length
      this.logger.log(`Processing batch: ${orphans.length} orphan assets`)

      // Process in parallel batches of 10 to avoid overwhelming S3
      const parallelBatches = 10
      for (let i = 0; i < orphans.length; i += parallelBatches) {
        const batch = orphans.slice(i, i + parallelBatches)
        
        const results = await Promise.allSettled(
          batch.map(async (orphan: { id: string; file_key: string }) => {
            try {
              const exists = await this.objectExists(orphan.file_key)
              if (exists) {
                await this.deleteObject(orphan.file_key)
              }
              await this.prisma.media_assets.update({
                where: { id: orphan.id },
                data: { status: 'failed', updated_at: new Date() },
              })
              return { success: true, id: orphan.id }
            } catch (err) {
              this.logger.error(
                `Failed deleting orphan asset ${orphan.id}: ${String(err)}`,
              )
              return { success: false, id: orphan.id }
            }
          }),
        )

        const batchDeleted = results.filter((r) => r.status === 'fulfilled' && r.value?.success).length
        const batchFailed = results.filter((r) => r.status !== 'fulfilled' || !r.value?.success).length
        totalDeleted += batchDeleted
        totalFailed += batchFailed

        this.logger.log(
          `Batch complete: Deleted ${batchDeleted} | Failed ${batchFailed} | Running total: ${totalDeleted}/${totalProcessed}`,
        )
      }

      // Stop if we got fewer than batchSize (means we're at the end)
      if (orphans.length < batchSize) {
        hasMore = false
      }
    }

    this.logger.log(
      `✅ Orphan cleanup complete. Total processed: ${totalProcessed} | Deleted: ${totalDeleted} | Failed: ${totalFailed}`,
    )
  }

  private async objectExists(key: string): Promise<boolean> {
    try {
      await this.s3Client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }))
      return true
    } catch {
      return false
    }
  }

  private async deleteObject(key: string): Promise<void> {
    await this.s3Client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }))
  }
}
