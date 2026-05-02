import { ENV } from '@futsmandu/utils'

export function extractKeyFromCdnUrl(cdnUrl: string): string {
  const base = ENV['S3_CDN_BASE_URL'] || ENV['S3_ENDPOINT'] || ''
  if (base && cdnUrl.startsWith(base)) {
    return cdnUrl.slice(base.replace(/\/+$/, '').length + 1)
  }
  try {
    return new URL(cdnUrl).pathname.replace(/^\//, '')
  } catch {
    return cdnUrl
  }
}
