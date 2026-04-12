// packages/media-core/src/interfaces/media.interfaces.ts
// Single source of truth for all media types across the platform.

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
  assetId:   string
  uploadUrl: string
  key:       string
  cdnUrl?:   string   // only for public assets
  expiresIn: number
}

export interface ConfirmUploadOptions {
  ownerId:   string
  assetId:   string
  key:       string
  assetType: AssetType
}

export interface ConfirmUploadResult {
  message:  string
  assetId:  string
  webpKey?: string | null
}

export interface SignedDownloadUrlOptions {
  key:       string
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
  uploadedAt: Date
}

export interface UploadStatusResult {
  status:   AssetStatus
  progress: number  // 0-100
  webpKey?: string | null
  error?:   string
}
