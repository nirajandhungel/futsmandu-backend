// packages/media/src/interfaces/media.interfaces.ts
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

// Whether the asset should be accessible publicly via CDN
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
  assetType: AssetType
  ownerId: string        // The authenticated user/owner making the request
  entityId: string       // playerId, ownerId, venueId — context-dependent
  docType?: KycDocType   // Only for kyc_document
  contentType?: string   // Defaults to image/jpeg for images, application/pdf for docs
}

export interface UploadUrlResult {
  assetId: string
  uploadUrl: string
  key: string
  cdnUrl?: string        // Only for public assets
  expiresIn: number      // Seconds
}

export interface ConfirmUploadOptions {
  ownerId: string
  assetId: string
  key: string
  assetType: AssetType
}

export interface SignedDownloadUrlOptions {
  key: string
  expiresIn?: number  // default 600s
}

// Job payload pushed to BullMQ image-processing queue
export interface ImageProcessingJobData {
  assetId: string
  key: string
  bucket: string
  assetType: AssetType
  targetWidth: number
  targetHeight: number
}