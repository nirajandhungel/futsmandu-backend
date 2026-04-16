// packages/media-core/src/interfaces/media.interfaces.ts
// OPTIMIZED: Added thumbKey to all relevant interfaces, instant-preview fields,
// and a slim ConfirmUploadResult that returns URL immediately (no blocking).

export type AssetType =
  | 'player_profile'
  | 'owner_profile'
  | 'venue_cover'
  | 'venue_gallery'
  | 'venue_verification'
  | 'kyc_document'

export type AssetStatus = 'pending' | 'processing' | 'ready' | 'failed'

export type KycDocType =
  | 'citizenship'
  | 'business_registration'
  | 'business_pan'

export const PUBLIC_ASSET_TYPES: AssetType[] = [
  'player_profile',
  'owner_profile',
  'venue_cover',
  'venue_gallery',
]

export const PRIVATE_ASSET_TYPES: AssetType[] = [
  'venue_verification',
  'kyc_document',
]

export interface RequestUploadUrlOptions {
  assetType:    AssetType
  ownerId:      string
  entityId:     string
  docType?:     KycDocType
  contentType?: string
}

export interface UploadUrlResult {
  assetId:    string
  uploadUrl:  string
  key:        string
  /** Public CDN URL for instant optimistic display BEFORE processing completes */
  cdnUrl?:    string
  /** Predicted WebP key (may 404 until processing finishes — use cdnUrl for instant display) */
  webpKey?:   string
  expiresIn:  number
}

export interface ConfirmUploadOptions {
  ownerId:   string
  assetId:   string
  key:       string
  assetType: AssetType
}

/**
 * Returned immediately after confirm — DO NOT block on processing.
 * UI should show cdnUrl instantly; poll /status/:assetId for webpKey once ready.
 */
export interface ConfirmUploadResult {
  message:   string
  assetId:   string
  /** Original CDN URL — available immediately, before any processing */
  cdnUrl?:   string
  /** Only populated after worker finishes (will be null on first response) */
  webpKey?:  string | null
  thumbKey?: string | null
  status:    AssetStatus
}

export interface SignedDownloadUrlOptions {
  key:        string
  expiresIn?: number  // default 600s
}

// Job payload pushed to BullMQ image-processing queue
export interface ImageProcessingJobData {
  assetId:      string
  key:          string
  bucket:       string
  assetType:    AssetType
  targetWidth:  number
  targetHeight: number
}

export interface GalleryItem {
  assetId:    string
  key:        string
  cdnUrl:     string
  signedUrl?: string
  webpUrl?:   string
  /** 400×300 WebP thumbnail — use this in list views, NOT full webpUrl */
  thumbUrl?:  string
  uploadedAt: Date
  status:     AssetStatus
}

export interface UploadStatusResult {
  status:    AssetStatus
  progress:  number       // 0-100
  webpKey?:  string | null
  thumbKey?: string | null
  /** CDN URL of the thumb — populated once processing is done */
  thumbUrl?: string | null
  error?:    string
}
