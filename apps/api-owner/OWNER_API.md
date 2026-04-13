# Owner API (owner-api) - Requests and Responses

## Base URL
- Base prefix (global): `/api/v1/owner`
- Swagger (dev): `/api/v1/owner/api/docs`
- Server port: `OWNER_API_PORT` (default `3002`)

## Response Envelope (success)
Owner API uses a global `ResponseInterceptor` so successful responses are wrapped as:
```json
{ "data": <controller-return-value> }
```

## Error Envelope
Owner API uses `AllExceptionsFilter`. Typical error response:
```json
{
  "error": "string message",
  "code": "ERROR_CODE",
  "statusCode": 400
}
```

## Authentication (OwnerJwtGuard)
Protected endpoints require the owner access token.

### Send access token
Prefer:
- Header: `Authorization: Bearer <accessToken>`

The guard also supports an access-token cookie:
- Cookie name checked by guard: `owner_token`

If token is missing/invalid you should expect `401`:
```json
{ "statusCode": 401, "error": "...", "code": "..." }
```

### Refresh and logout cookies
Login sets a refresh cookie:
- Cookie name: `owner_refresh`
- Cookie path: `/api/v1/owner/auth` (note: cookie path differs from some route prefixes; use the endpoint as shown below)

Refresh token rotation endpoint reads `owner_refresh` from cookies.

Logout clears `owner_refresh`.

## Roles
Some endpoints are restricted using `RolesGuard`.
- The guard compares `requiredRoles` against `owner.role` from the JWT payload.
- In the current owner-auth implementation, `login` signs tokens with role `OWNER_ADMIN`.

## Public endpoints

### Health
`GET /api/v1/owner/health`

No auth required.

Example response:
```json
{
  "data": {
    "status": "ok",
    "service": "owner-api",
    "timestamp": "2026-03-26T00:00:00.000Z",
    "uptime": 1234
  }
}
```

## Owner Auth Endpoints
All these are under the controller prefix `auth` plus the global prefix.

Base: `/api/v1/owner/auth`

### Register
`POST /api/v1/owner/auth/register`

Public. No auth required.

Request body (`RegisterOwnerDto`):
- `name` (string, required)
- `email` (string, required, email)
- `phone` (string, required; Nepal phone regex enforced)
- `password` (string, required)
- `business_name` (string, optional)

Success response (`owner` fields selected in service):
```json
{
  "data": {
    "id": "uuid",
    "name": "string",
    "email": "string",
    "phone": "string",
    "business_name": "string | null",
    "created_at": "ISO-8601"
  }
}
```

### Login
`POST /api/v1/owner/auth/login`

Public. No auth required.

Request body (`LoginOwnerDto`):
- `email` (string, required)
- `password` (string, required)

Server behavior:
- Returns **both tokens in JSON** (mobile best practice)
- Also sets refresh cookie `owner_refresh` for backward compatibility with web clients

Success response:
```json
{
  "data": {
    "accessToken": "JWT_ACCESS_TOKEN",
    "refreshToken": "JWT_REFRESH_TOKEN",
    "owner": {
      "id": "uuid",
      "name": "string",
      "email": "string",
      "phone": "string",
      "business_name": "string | null",
      "is_verified": true,
      "is_active": true
    }
  }
}
```

**Mobile clients**: Use the `refreshToken` from the response body (recommended).  
**Web clients**: Can use either the `refreshToken` from body or the `owner_refresh` cookie.

### Refresh
`POST /api/v1/owner/auth/refresh`

Public. No auth header required, but cookie is required.

Request:
- Send cookie: `owner_refresh=<refreshToken>`

Success response:
```json
{ "data": { "accessToken": "JWT_ACCESS_TOKEN" } }
```

### Logout
`POST /api/v1/owner/auth/logout`

Protected.

Success response:
```json
{ "data": { "message": "Logged out" } }
```

### Upload Docs (presigned PUT URL)
`POST /api/v1/owner/auth/upload-docs`

Protected.

Request body (`UploadDocDto`):
- `docType`: one of `citizenship | pan | business_reg | other`

Success response:
```json
{
  "data": {
    "uploadUrl": "PRESIGNED_PUT_URL",
    "key": "verify/<ownerId>/<docType>.pdf"
  }
}
```

## Bookings (owner scoped)
Base: `/api/v1/owner/bookings`

### Court Slot Calendar (booking overlay)
`GET /api/v1/owner/bookings/courts/:id/calendar?date=YYYY-MM-DD`

Protected.

Query:
- `date` (YYYY-MM-DD, required)

Response (`SlotGridItem[]`):
```json
{
  "data": [
    {
      "startTime": "17:00",
      "endTime": "18:00",
      "status": "AVAILABLE | HELD | PENDING_PAYMENT | CONFIRMED",
      "price": 1234,
      "displayPrice": "string"
    }
  ]
}
```

### Create Walk-in Offline Booking
`POST /api/v1/owner/bookings/offline`

Protected.

Request body (`CreateOfflineBookingDto`):
- `court_id` (uuid, required)
- `booking_date` (YYYY-MM-DD, required)
- `start_time` (HH:MM, required; validated by regex)
- `booking_type` (`offline_cash | offline_paid | offline_reserved`, required)
- `customer_name` (string, required, max length enforced)
- `customer_phone` (Nepal phone regex enforced)
- `notes` (string, optional)

Success response (selected booking fields):
```json
{
  "data": {
    "id": "uuid",
    "booking_type": "offline_cash | offline_paid | offline_reserved",
    "status": "CONFIRMED",
    "start_time": "HH:MM",
    "end_time": "HH:MM",
    "booking_date": "ISO-8601",
    "total_amount": 0,
    "offline_customer_name": "string"
  }
}
```

### List Bookings (with filters)
`GET /api/v1/owner/bookings?date=YYYY-MM-DD&courtId=<uuid>&status=...&page=1`

Protected.

Query (`ListBookingsQueryDto`):
- `date` (YYYY-MM-DD, optional)
- `courtId` (uuid, optional)
- `status` (one of `HELD | PENDING_PAYMENT | CONFIRMED | CANCELLED | NO_SHOW | COMPLETED`, optional)
- `page` (int >= 1, optional; default page=1)

Success response:
```json
{
  "data": {
    "data": [
      {
        "id": "uuid",
        "booking_type": "string",
        "status": "string",
        "booking_date": "ISO-8601",
        "start_time": "HH:MM",
        "end_time": "HH:MM",
        "total_amount": 1234,
        "offline_customer_name": "string",
        "offline_customer_phone": "string",
        "created_at": "ISO-8601",
        "player": { "id": "uuid", "name": "string", "phone": "string" },
        "court": { "id": "uuid", "name": "string" },
        "venue": { "id": "uuid", "name": "string" }
      }
    ],
    "meta": {
      "page": 1,
      "limit": 20,
      "total": 100,
      "totalPages": 5
    }
  }
}
```

### Mark Attendance / No-shows
`PUT /api/v1/owner/bookings/:id/attendance`

Protected.

Request body (`MarkAttendanceDto`):
- `no_show_ids`: array of `uuid` (players who did not show up)

Success response:
```json
{
  "data": {
    "message": "Attendance recorded",
    "noShowCount": 2
  }
}
```

## Courts (calendar + blocks/maintenance)
Base: `/api/v1/owner/courts`

### Court Calendar (DB + Redis holds)
`GET /api/v1/owner/courts/:courtId/calendar?date=YYYY-MM-DD`

Protected.

Query:
- `date` (YYYY-MM-DD)

Success response:
```json
{
  "data": {
    "date": "YYYY-MM-DD",
    "courtId": "uuid",
    "slots": [
      {
        "startTime": "HH:MM",
        "endTime": "HH:MM",
        "status": "AVAILABLE | HELD | PENDING_PAYMENT | CONFIRMED",
        "price": 1234,
        "displayPrice": "string",
        "bookingId": "uuid | undefined",
        "playerName": "string | undefined",
        "bookingType": "string | undefined"
      }
    ]
  }
}
```

### Block a Court Slot
`POST /api/v1/owner/courts/:courtId/blocks`

Protected.

Request body fields:
- `date` (YYYY-MM-DD string)
- `startTime` (HH:MM string)
- `reason` (string, optional)

Success response (block selected fields):
```json
{ "data": { "id": "uuid", "start_time": "HH:MM", "end_time": "HH:MM", "status": "CONFIRMED" } }
```

### Unblock a Court Block
`DELETE /api/v1/owner/courts/blocks/:blockId`

Protected.

Success response:
```json
{ "data": { "message": "Slot unblocked" } }
```

## Venue Management
Base: `/api/v1/owner/venues`

### List Venues
`GET /api/v1/owner/venues`

Protected.

Response: list of venues (fields selected in service). Example shape:
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "slug": "string",
      "description": "string",
      "address": {},
      "latitude": 0,
      "longitude": 0,
      "amenities": ["string"],
      "cover_image_url": "string | null",
      "is_verified": true,
      "avg_rating": 4.7,
      "total_reviews": 10,
      "full_refund_hours": 24,
      "partial_refund_hours": 6,
      "partial_refund_pct": 50,
      "created_at": "ISO-8601",
      "updated_at": "ISO-8601",
      "_count": { "courts": 2 }
    }
  ]
}
```

### Create Venue
`POST /api/v1/owner/venues`

Protected.

Request body (`CreateVenueDto`):
- `name` (string, required)
- `description` (string, optional)
- `address` (object, required) with:
  - `street`, `city`, `district`
- `latitude` (number, optional)
- `longitude` (number, optional)
- `amenities` (string[], optional)
- `full_refund_hours` (number, optional)
- `partial_refund_hours` (number, optional)
- `partial_refund_pct` (number, optional)

Success response (selected fields):
```json
{
  "data": {
    "id": "uuid",
    "name": "string",
    "slug": "string",
    "is_verified": false,
    "created_at": "ISO-8601"
  }
}
```

### Update Venue
`PUT /api/v1/owner/venues/:id`

Protected.

Request body (`UpdateVenueDto`): optional fields from `CreateVenueDto` (address/amenities/lat/lng/etc).

Success response (selected fields):
```json
{ "data": { "id": "uuid", "name": "string", "slug": "string", "address": {}, "amenities": ["string"], "updated_at": "ISO-8601" } }
```

### List Courts for a Venue
`GET /api/v1/owner/venues/:id/courts`

Protected.

Success response:
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "court_type": "string",
      "surface": "string",
      "capacity": 10,
      "min_players": 4,
      "slot_duration_mins": 60,
      "open_time": "HH:MM",
      "close_time": "HH:MM",
      "created_at": "ISO-8601",
      "_count": { "pricing_rules": 3 }
    }
  ]
}
```

### Create Court
`POST /api/v1/owner/venues/:id/courts`

Protected.

Request body (`CreateCourtDto`):
- `name` (string, required)
- `court_type` (string, optional)
- `surface` (string, optional)
- `capacity` (number, optional)
- `min_players` (number, optional)
- `slot_duration_mins` (number, optional)
- `open_time` (HH:MM string, optional)
- `close_time` (HH:MM string, optional)

Success response:
```json
{ "data": { "id": "uuid", "name": "string", "court_type": "string", "slot_duration_mins": 60, "created_at": "ISO-8601" } }
```

### Update Court Settings
`PUT /api/v1/owner/courts/:id`

Protected.

Request body (`UpdateCourtDto`): optional fields similar to `CreateCourtDto`.

Success response:
```json
{ "data": { "id": "uuid", "name": "string", "open_time": "HH:MM", "close_time": "HH:MM" } }
```

### Soft Delete Court (OWNER_ADMIN only)
`DELETE /api/v1/owner/courts/:id`

Protected + role required: `OWNER_ADMIN`.

Success response:
```json
{ "data": { "message": "Court deactivated successfully" } }
```

### Get Cover Image Upload URL (R2)
`POST /api/v1/owner/venues/:id/images/upload-url`

Protected.

Success response:
```json
{ "data": { "uploadUrl": "PRESIGNED_PUT_URL", "cdnUrl": "https://.../venues/<venueId>/cover.jpg" } }
```

## Pricing Rules
Base: `/api/v1/owner`

### List Pricing Rules
`GET /api/v1/owner/courts/:id/pricing`

Protected.

Success response: array of pricing rules with fields selected in service, including:
- `id`, `rule_type`, `priority`, `price`, `modifier`, `days_of_week`, `start_time`, `end_time`, `date_from`, `date_to`, `hours_before`, `is_active`, `created_at`

### Create Pricing Rule
`POST /api/v1/owner/courts/:id/pricing`

Protected.

Request body (`CreatePricingRuleDto`):
- `rule_type` (base | offpeak | weekend | peak | lastminute | custom)
- `priority` (number; must match spec PRIORITY_MAP for known rule types)
- `price` (number; paisa)
- `modifier` (`fixed | percent_add | percent_off`)
- `days_of_week` (number[] optional)
- `start_time`, `end_time` (optional)
- `date_from`, `date_to` (optional, date strings)
- `hours_before` (optional)

Success response:
```json
{
  "data": {
    "id": "uuid",
    "rule_type": "string",
    "priority": 1,
    "price": 1234,
    "modifier": "fixed | percent_add | percent_off"
  }
}
```

### Update Pricing Rule
`PUT /api/v1/owner/pricing/:ruleId`

Protected.

Request body (`UpdatePricingRuleDto`): optional fields
- `price`, `modifier`, `days_of_week`, `start_time`, `end_time`, `date_from`, `date_to`, `hours_before`, `is_active`

Success response:
```json
{ "data": { "id": "uuid", "rule_type": "string", "price": 1234, "is_active": true } }
```

### Delete Pricing Rule
`DELETE /api/v1/owner/pricing/:ruleId`

Protected.

Success response:
```json
{ "data": { "message": "Pricing rule deleted" } }
```

### Preview Price
`GET /api/v1/owner/courts/:id/pricing/preview?date=YYYY-MM-DD&time=HH:MM`

Protected.

Query params:
- `date` (YYYY-MM-DD)
- `time` (string; non-empty)

Success response (computed preview):
```json
{
  "data": {
    "price": 1234,
    "displayPrice": "string",
    "ruleId": "uuid | null",
    "ruleType": "string",
    "date": "YYYY-MM-DD",
    "time": "HH:MM"
  }
}
```

## Analytics
Base: `/api/v1/owner/analytics`

All endpoints:
- Protected.
- Query supports `from` and `to` (optional ISO date strings)
- Optional `courtId` (uuid)

### Summary
`GET /api/v1/owner/analytics/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&courtId=uuid`

Response:
```json
{
  "data": {
    "totalRevenuePaisa": 0,
    "totalRevenueNPR": "0.00",
    "confirmedBookings": 0,
    "avgBookingValue": 0,
    "byStatus": { "CONFIRMED": 10, "COMPLETED": 3 }
  }
}
```

### Heatmap
`GET /api/v1/owner/analytics/heatmap?from=YYYY-MM-DD&to=YYYY-MM-DD&courtId=uuid`

Response:
```json
{
  "data": {
    "grid": [[0,0,...],[...]],
    "totalBookings": 123
  }
}
```

### Revenue
`GET /api/v1/owner/analytics/revenue?from=YYYY-MM-DD&to=YYYY-MM-DD&courtId=uuid&groupBy=day|week|month`

Response:
```json
{
  "data": {
    "groupBy": "day",
    "data": [
      { "period": "2026-03-01", "totalPaisa": 1234, "totalNPR": "12.34" }
    ]
  }
}
```

### No-show Rate
`GET /api/v1/owner/analytics/no-show-rate?from=YYYY-MM-DD&to=YYYY-MM-DD&courtId=uuid`

Response:
```json
{
  "data": [
    {
      "courtId": "uuid",
      "courtName": "string",
      "venueName": "string",
      "total": 10,
      "noShows": 2,
      "rate": 20.0
    }
  ]
}
```

## Staff Management (OWNER_ADMIN only)
Base: `/api/v1/owner/staff`

All staff endpoints require `OwnerJwtGuard + RolesGuard`.

### List Staff
`GET /api/v1/owner/staff`

Success response:
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "email": "string",
      "phone": "string",
      "role": "OWNER_ADMIN | OWNER_STAFF",
      "is_active": true,
      "created_at": "ISO-8601"
    }
  ]
}
```

### Invite Staff
`POST /api/v1/owner/staff/invite`

Request body (`InviteStaffDto`):
- `name` (string)
- `email` (string)
- `phone` (string length validated)
- `password` (string length validated)
- `role` (`OWNER_ADMIN | OWNER_STAFF`)

Success response:
```json
{
  "data": {
    "id": "uuid",
    "name": "string",
    "email": "string",
    "phone": "string",
    "created_at": "ISO-8601",
    "role": "OWNER_ADMIN | OWNER_STAFF"
  }
}
```

### Update Staff Role (OWNER_ADMIN only)
`PUT /api/v1/owner/staff/:id/role`

Request body (`UpdateStaffRoleDto`):
- `role` (`OWNER_ADMIN | OWNER_STAFF`)

Success response:
```json
{ "data": { "id": "uuid", "role": "OWNER_ADMIN | OWNER_STAFF", "message": "Role updated" } }
```

### Deactivate Staff
`DELETE /api/v1/owner/staff/:id`

Success response:
```json
{ "data": { "message": "Staff deactivated" } }
```

## Media (R2 presigned URLs)
Base: `/api/v1/owner/media`

All media endpoints are protected by `OwnerJwtGuard`.

### Request Upload URL (Legacy, generic)
`POST /api/v1/owner/media/upload-url`

Request body:
- `assetType` (required): `owner_profile | kyc_document | venue_cover | venue_gallery | venue_verification`
- `entityId` (required):
  - For `owner_profile` and `kyc_document`: must be your authenticated owner id.
  - For `venue_cover`, `venue_gallery`, `venue_verification`: must be the venue id that belongs to you.
- `docType` (required only when `assetType=kyc_document`): one of `nid_front | nid_back | business_registration | tax_certificate`

Example (`kyc_document`):
```json
{
  "assetType": "kyc_document",
  "entityId": "<OWNER_ID>",
  "docType": "nid_front"
}
```

Success response:
```json
{
  "data": {
    "uploadUrl": "PRESIGNED_PUT_URL",
    "key": "owners/<ownerId>/kyc/nid_front.pdf",
    "expiresIn": 600
  }
}
```

`cdnUrl` is included for public asset types (for example venue images). KYC documents are private and do not return `cdnUrl`.

### Confirm Upload
`POST /api/v1/owner/media/confirm-upload`

Request body:
- `key` (required)
- `assetType` (required): same asset type used in upload-url request

Success response:
```json
{ "data": { "message": "Upload confirmed — processing started" } }
```

For non-KYC assets, this enqueues image processing. For KYC documents, asset status is marked as `ready` immediately.

### KYC Upload URL (recommended)
`POST /api/v1/owner/media/kyc/upload-url`

Request body:
- `docType` (required): `nid_front | nid_back | business_registration | tax_certificate`

Success response:
```json
{
  "data": {
    "uploadUrl": "PRESIGNED_PUT_URL",
    "key": "owners/<ownerId>/kyc/nid_front.pdf",
    "expiresIn": 600
  }
}
```

### Venue Cover Upload URL (recommended)
`POST /api/v1/owner/media/venues/:venueId/images/cover/upload-url`

### Venue Gallery Upload URL (recommended)
`POST /api/v1/owner/media/venues/:venueId/images/gallery/upload-url`

### Owner Avatar Upload URL (recommended)
`POST /api/v1/owner/media/profile/avatar/upload-url`

### Delete Asset
`DELETE /api/v1/owner/media/asset?assetId=<MEDIA_ASSET_ID>`

Success response:
```json
{ "data": null }
```

