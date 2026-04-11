// owner-api/src/modules/media/owner-asset-types.ts

import { AssetType } from '@futsmandu/media-core'

export const OWNER_ASSET_TYPES = [
  'owner_profile',
  'venue_cover',
  'venue_gallery',
  'venue_verification',
  'kyc_document',
] as const satisfies readonly AssetType[]

export type OwnerAssetType = typeof OWNER_ASSET_TYPES[number]