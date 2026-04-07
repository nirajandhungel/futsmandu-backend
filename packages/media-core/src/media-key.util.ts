// packages/media/src/media-key.util.ts
// Single source of truth for all R2 key paths.
// NEVER generate keys anywhere else — always call this util.
//
// R2 structure:
//   players/{playerId}/profile/{uuid}.jpg          ← public
//   owners/{ownerId}/profile/{uuid}.jpg            ← public
//   owners/{ownerId}/kyc/{docType}.pdf             ← PRIVATE, no CDN
//   venues/{venueId}/cover/{uuid}.jpg              ← public
//   venues/{venueId}/gallery/{uuid}.jpg            ← public
//   venues/{venueId}/verification/{uuid}.jpg       ← PRIVATE

import { AssetType, KycDocType } from './interfaces/media.interfaces.js'
import { randomUUID } from 'node:crypto'

export interface KeyGeneratorOptions {
  assetType: AssetType
  entityId: string
  docType?: KycDocType
}

export function generateMediaKey(opts: KeyGeneratorOptions): string {
  const uuid = randomUUID()

  switch (opts.assetType) {
    case 'player_profile':
      return `players/${opts.entityId}/profile/${uuid}.jpg`

    case 'owner_profile':
      return `owners/${opts.entityId}/profile/${uuid}.jpg`

    case 'kyc_document': {
      if (!opts.docType) throw new Error('docType required for kyc_document')
      // Deterministic path — one file per docType per owner. No UUID.
      // Uploading again overwrites. Intentional.
      return `owners/${opts.entityId}/kyc/${opts.docType}.pdf`
    }

    case 'venue_cover':
      return `venues/${opts.entityId}/cover/${uuid}.jpg`

    case 'venue_gallery':
      return `venues/${opts.entityId}/gallery/${uuid}.jpg`

    case 'venue_verification':
      return `venues/${opts.entityId}/verification/${uuid}.jpg`

    default:
      throw new Error(`Unknown assetType: ${opts.assetType}`)
  }
}

// Content type per asset type
export function getContentType(assetType: AssetType): string {
  if (assetType === 'kyc_document') return 'application/pdf'
  return 'image/jpeg'
}

// Cache-Control header per asset type
export function getCacheControl(assetType: AssetType): string {
  switch (assetType) {
    case 'player_profile':
    case 'owner_profile':
      return 'public, max-age=3600'          // 1 hour — profile images change occasionally

    case 'venue_cover':
    case 'venue_gallery':
      return 'public, max-age=86400'         // 24 hours — venue images rarely change

    case 'venue_verification':
    case 'kyc_document':
      return 'no-store, private'             // Never cached — private docs

    default:
      return 'public, max-age=3600'
  }
}

// Target dimensions for Sharp resize per asset type
export function getResizeDimensions(assetType: AssetType): { width: number; height: number } {
  switch (assetType) {
    case 'player_profile':
    case 'owner_profile':
      return { width: 400, height: 400 }    // Square profile images

    case 'venue_cover':
      return { width: 1280, height: 720 }   // 16:9 hero image

    case 'venue_gallery':
      return { width: 1024, height: 768 }   // Gallery standard

    case 'venue_verification':
      return { width: 1200, height: 900 }   // Full resolution for admin review

    default:
      return { width: 800, height: 600 }
  }
}