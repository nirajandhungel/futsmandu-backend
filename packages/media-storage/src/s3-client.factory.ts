import { S3Client } from '@aws-sdk/client-s3'

export interface S3ClientOptions {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle?: boolean
}

export function createS3Client(options: S3ClientOptions): S3Client {
  return new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: options.forcePathStyle,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  })
}
