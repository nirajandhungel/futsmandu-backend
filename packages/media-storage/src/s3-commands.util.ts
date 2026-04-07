import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export interface StorageConfig {
  s3Client: S3Client
  bucket: string
}

export interface GenerateSignedUploadUrlOptions {
  key: string
  contentType: string
  cacheControl: string
  expiresIn?: number // default 600
}

export async function generateSignedUploadUrl(
  config: StorageConfig,
  opts: GenerateSignedUploadUrlOptions
): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: config.bucket,
    Key: opts.key,
    ContentType: opts.contentType,
    CacheControl: opts.cacheControl,
  })
  return getSignedUrl(config.s3Client, cmd, { expiresIn: opts.expiresIn ?? 600 })
}

export interface GenerateSignedDownloadUrlOptions {
  key: string
  expiresIn?: number // default 600
}

export async function generateSignedDownloadUrl(
  config: StorageConfig,
  opts: GenerateSignedDownloadUrlOptions
): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: config.bucket,
    Key: opts.key,
  })
  return getSignedUrl(config.s3Client, cmd, { expiresIn: opts.expiresIn ?? 600 })
}

export async function deleteStorageObject(
  config: StorageConfig,
  key: string
): Promise<void> {
  await config.s3Client.send(new DeleteObjectCommand({
    Bucket: config.bucket,
    Key: key,
  }))
}

export async function objectExistsInStorage(
  config: StorageConfig,
  key: string
): Promise<boolean> {
  try {
    await config.s3Client.send(new HeadObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }))
    return true
  } catch {
    return false
  }
}

export function formatCdnUrl(cdnBaseUrl: string, key: string): string {
  // Ensure no double slashes if cdnBaseUrl has trailing slash
  const base = cdnBaseUrl.endsWith('/') ? cdnBaseUrl.slice(0, -1) : cdnBaseUrl;
  return `${base}/${key}`;
}
