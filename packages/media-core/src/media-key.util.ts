// packages/media-core/src/media-key.util.ts
// OPTIMIZED: Optimistic UI support + CDN caching improvements
// SINGLE SOURCE OF TRUTH for all R2 key generation + media rules
//
// RULE: NEVER generate storage keys outside this file.

import { randomUUID } from 'node:crypto'
import { AssetType, KycDocType } from './interfaces/media.interfaces.js'

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export interface KeyGeneratorOptions {
  assetType:  AssetType
  entityId:   string
  docType?:   KycDocType
  extension?: string
}

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]

// ─────────────────────────────────────────────────────────────
// MIME → EXTENSION MAP
// ─────────────────────────────────────────────────────────────

const MIME_TO_EXTENSIONS: Record<AllowedMimeType, readonly string[]> = {
  'image/jpeg':      ['.jpg', '.jpeg'],
  'image/png':       ['.png'],
  'image/webp':      ['.webp'],
  'application/pdf': ['.pdf'],
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

function normalizeExt(ext?: string): string | undefined {
  if (!ext) return undefined
  return ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
}

// ─────────────────────────────────────────────────────────────
// KEY GENERATION (CRITICAL CORE LOGIC)
// ─────────────────────────────────────────────────────────────

export function generateMediaKey(opts: KeyGeneratorOptions): string {
  const uuid = randomUUID()
  const ext  = normalizeExt(opts.extension)

  switch (opts.assetType) {
    case 'player_profile':
      return `players/${opts.entityId}/profile/${uuid}${ext ?? '.jpg'}`

    case 'owner_profile':
      return `owners/${opts.entityId}/profile/${uuid}${ext ?? '.jpg'}`

    case 'kyc_document': {
      if (!opts.docType) {
        throw new Error('docType is required for kyc_document')
      }
      // deterministic path (overwrite allowed per docType)
      return `owners/${opts.entityId}/kyc/${opts.docType}${ext ?? '.pdf'}`
    }

    case 'venue_cover':
      return `venues/${opts.entityId}/cover/${uuid}${ext ?? '.jpg'}`

    case 'venue_gallery':
      return `venues/${opts.entityId}/gallery/${uuid}${ext ?? '.jpg'}`

    case 'venue_verification':
      return `venues/${opts.entityId}/verification/${uuid}${ext ?? '.jpg'}`

    default: {
      // ensures compile-time exhaustiveness if AssetType changes
      const _exhaustive: never = opts.assetType
      throw new Error(`Unknown assetType: ${_exhaustive}`)
    }
  }
}

// ─────────────────────────────────────────────────────────────
// OPTIMISTIC UI HELPERS (VERY IMPORTANT FOR FLUTTER UX)
// ─────────────────────────────────────────────────────────────

/** Predict WebP output key created by image worker */
export function predictWebpKey(originalKey: string): string {
  return originalKey.replace(/\.[^.]+$/, '.webp')
}

/** Predict thumbnail output key created by image worker */
export function predictThumbKey(originalKey: string): string {
  return originalKey.replace(/\.[^.]+$/, '_thumb.webp')
}

// ─────────────────────────────────────────────────────────────
// MIME + EXTENSION RULES
// ─────────────────────────────────────────────────────────────

export function getContentType(assetType: AssetType): string {
  return assetType === 'kyc_document'
    ? 'application/pdf'
    : 'image/jpeg'
}

export function getAllowedMimeTypesForAssetType(
  assetType: AssetType,
): AllowedMimeType[] {
  if (assetType === 'kyc_document') {
    return ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  }
  return ['image/jpeg', 'image/png', 'image/webp']
}

export function getAllowedExtensionsForAssetType(assetType: AssetType): string[] {
  return getAllowedMimeTypesForAssetType(assetType)
    .flatMap(mime => MIME_TO_EXTENSIONS[mime])
}

export function getPreferredExtensionForMimeType(mime: AllowedMimeType): string {
  return MIME_TO_EXTENSIONS[mime][0]
}

// ─────────────────────────────────────────────────────────────
// CDN CACHE POLICY (OPTIMIZED FOR SCALE)
// ─────────────────────────────────────────────────────────────

/**
 * Cache strategy:
 * - Profiles: frequently updated → 1 hour + SWR
 * - Venue images: stable → 7 days
 * - KYC: private → never cached
 */
export function getCacheControl(assetType: AssetType): string {
  switch (assetType) {
    case 'player_profile':
    case 'owner_profile':
      return 'public, max-age=3600, stale-while-revalidate=86400'

    case 'venue_cover':
    case 'venue_gallery':
      return 'public, max-age=604800, stale-while-revalidate=86400' // 7 days

    case 'venue_verification':
    case 'kyc_document':
      return 'no-store, private'

    default:
      return 'public, max-age=3600'
  }
}

// ─────────────────────────────────────────────────────────────
// IMAGE PROCESSING DIMENSIONS
// ─────────────────────────────────────────────────────────────

export function getResizeDimensions(
  assetType: AssetType,
): { width: number; height: number } {
  switch (assetType) {
    case 'player_profile':
    case 'owner_profile':
      return { width: 400, height: 400 }

    case 'venue_cover':
      return { width: 1280, height: 720 }

    case 'venue_gallery':
      return { width: 1024, height: 768 }

    case 'venue_verification':
      return { width: 1200, height: 900 }

    default:
      return { width: 800, height: 600 }
  }
}