// packages/media-core/src/media-key.util.ts
// Single source of truth for all R2 key paths.
// NEVER generate keys anywhere else — always call this util.
//
// R2 structure:
//   players/{playerId}/profile/{uuid}.jpg          ← public
//   owners/{ownerId}/profile/{uuid}.jpg            ← public
//   owners/{ownerId}/kyc/{docType}.{ext}           ← PRIVATE
//   venues/{venueId}/cover/{uuid}.jpg              ← public
//   venues/{venueId}/gallery/{uuid}.jpg            ← public
//   venues/{venueId}/verification/{uuid}.jpg       ← PRIVATE

import { AssetType, KycDocType } from './interfaces/media.interfaces.js'
import { randomUUID } from 'node:crypto'

export interface KeyGeneratorOptions {
  assetType: AssetType
  entityId:  string
  docType?:  KycDocType
  extension?: string
}

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]

const MIME_TO_EXTENSIONS: Record<AllowedMimeType, string[]> = {
  'image/jpeg':      ['.jpg', '.jpeg'],
  'image/png':       ['.png'],
  'image/webp':      ['.webp'],
  'application/pdf': ['.pdf'],
}

function normalizeExt(ext?: string): string | undefined {
  if (!ext) return undefined
  const withDot = ext.startsWith('.') ? ext : `.${ext}`
  return withDot.toLowerCase()
}

export function generateMediaKey(opts: KeyGeneratorOptions): string {
  const uuid          = randomUUID()
  const normalizedExt = normalizeExt(opts.extension)

  switch (opts.assetType) {
    case 'player_profile':
      return `players/${opts.entityId}/profile/${uuid}${normalizedExt ?? '.jpg'}`

    case 'owner_profile':
      return `owners/${opts.entityId}/profile/${uuid}${normalizedExt ?? '.jpg'}`

    case 'kyc_document': {
      if (!opts.docType) throw new Error('docType required for kyc_document')
      // Deterministic — one file per docType per owner. Re-uploading overwrites. Intentional.
      return `owners/${opts.entityId}/kyc/${opts.docType}${normalizedExt ?? '.pdf'}`
    }

    case 'venue_cover':
      return `venues/${opts.entityId}/cover/${uuid}${normalizedExt ?? '.jpg'}`

    case 'venue_gallery':
      return `venues/${opts.entityId}/gallery/${uuid}${normalizedExt ?? '.jpg'}`

    case 'venue_verification':
      return `venues/${opts.entityId}/verification/${uuid}${normalizedExt ?? '.jpg'}`

    default:
      throw new Error(`Unknown assetType: ${opts.assetType}`)
  }
}

export function getContentType(assetType: AssetType): string {
  return assetType === 'kyc_document' ? 'application/pdf' : 'image/jpeg'
}

export function getAllowedMimeTypesForAssetType(assetType: AssetType): AllowedMimeType[] {
  if (assetType === 'kyc_document') return ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  return ['image/jpeg', 'image/png', 'image/webp']
}

export function getAllowedExtensionsForAssetType(assetType: AssetType): string[] {
  return getAllowedMimeTypesForAssetType(assetType).flatMap(mime => MIME_TO_EXTENSIONS[mime])
}

export function getPreferredExtensionForMimeType(mime: AllowedMimeType): string {
  return MIME_TO_EXTENSIONS[mime][0]
}

export function getCacheControl(assetType: AssetType): string {
  switch (assetType) {
    case 'player_profile':
    case 'owner_profile':
      return 'public, max-age=3600'

    case 'venue_cover':
    case 'venue_gallery':
      return 'public, max-age=86400'

    case 'venue_verification':
    case 'kyc_document':
      return 'no-store, private'

    default:
      return 'public, max-age=3600'
  }
}

export function getResizeDimensions(assetType: AssetType): { width: number; height: number } {
  switch (assetType) {
    case 'player_profile':
    case 'owner_profile':
      return { width: 400,  height: 400  }

    case 'venue_cover':
      return { width: 1280, height: 720  }

    case 'venue_gallery':
      return { width: 1024, height: 768  }

    case 'venue_verification':
      return { width: 1200, height: 900  }

    default:
      return { width: 800,  height: 600  }
  }
}
