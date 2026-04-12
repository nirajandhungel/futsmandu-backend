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
    const maxAgeHours = Number.isFinite(ENV['MEDIA_ORPHAN_MAX_AGE_HOURS']) ? ENV['MEDIA_ORPHAN_MAX_AGE_HOURS'] : 24
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000)

    this.logger.log(`Scanning for orphan media uploads (status = processing, age > ${maxAgeHours}h)`)

    const orphans = await this.prisma.media_assets.findMany({
      where: {
        status: 'processing',
        updatedAt: { lt: cutoff },
      },
      select: {
        id: true,
        key: true,
      },
      take: 500,
      orderBy: { updatedAt: 'asc' },
    })

    if (orphans.length === 0) {
      this.logger.log('No orphan media uploads found')
      return
    }

    this.logger.log(`Found ${orphans.length} orphan media assets`)
    this.logger.log('Deleting from R2 + marking DB as expired')

    let deleted = 0
    let failed = 0

    for (const orphan of orphans) {
      this.logger.log(`Deleting orphan asset: ${orphan.id} (R2 key: ${orphan.key})`)
      try {
        const exists = await this.objectExists(orphan.key)
        if (exists) {
          await this.deleteObject(orphan.key)
        }
        await this.prisma.media_assets.update({
          where: { id: orphan.id },
          data: { status: 'failed', updatedAt: new Date() },
        })
        deleted += 1
      } catch (err) {
        failed += 1
        this.logger.error(`Failed deleting orphan asset ${orphan.id}: ${String(err)}`)
      }
    }

    const remaining = Math.max(orphans.length - deleted - failed, 0)
    this.logger.log(`Cleanup complete. Deleted: ${deleted} | Failed: ${failed} | Remaining: ${remaining}`)
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
