// CHANGED: [Input sanitization layer — new file]
// NEW ISSUES FOUND: none (new file)

// apps/player-api/src/common/pipes/sanitize.pipe.ts
// Global sanitization pipe — applied after ValidationPipe in main.ts.
// - Trims whitespace from all string fields
// - Strips HTML tags from comment/reason/notes/description fields
// - Normalizes email to lowercase
//
// This is defence-in-depth on top of @Transform decorators on individual DTOs.

import { Injectable, PipeTransform, ArgumentMetadata } from '@nestjs/common'

const HTML_TAG_RE   = /<[^>]*>/g
const FREETEXT_KEYS = new Set(['comment', 'reason', 'notes', 'description', 'message', 'body'])

function sanitizeValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value

  let v = value.trim()

  if (key === 'email') {
    v = v.toLowerCase()
  }

  if (FREETEXT_KEYS.has(key)) {
    v = v.replace(HTML_TAG_RE, '')
  }

  return v
}

function sanitizeObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(item => sanitizeObject(item))

  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof val === 'string') {
      result[key] = sanitizeValue(key, val)
    } else if (typeof val === 'object' && val !== null) {
      result[key] = sanitizeObject(val)
    } else {
      result[key] = val
    }
  }
  return result
}

@Injectable()
export class SanitizePipe implements PipeTransform {
  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    return sanitizeObject(value)
  }
}
