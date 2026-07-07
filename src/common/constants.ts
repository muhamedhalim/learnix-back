export const FILE_LIMITS = {
  PROFILE_PICTURE_MAX_SIZE: 5 * 1024 * 1024, // 5MB
  THUMBNAIL_MAX_SIZE: 5 * 1024 * 1024, // 5MB
  VIDEO_MAX_SIZE: 100 * 1024 * 1024, // 100MB
  RESOURCE_MAX_SIZE: 500 * 1024 * 1024, // 500MB
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'],
} as const;

export const CODE_VALIDATION = {
  MAX_LENGTH: 5000, // Maximum code characters
  QUERY_TIMEOUT_MS: 5000, // 5 seconds SQL query timeout
  MAX_OUTPUT_SIZE: 50_000, // 50KB maximum output
} as const;

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 10,
  MAX_LIMIT: 100,
} as const;

export const DOCKER = {
  MAX_CONCURRENT_CONTAINERS: 5,
  MEMORY_LIMIT: 256 * 1024 * 1024, // 256MB
  CPU_SHARES: 512, // CPU allocation shares
  CONTAINER_TIMEOUT: 10_000, // 10 seconds
  MAX_OUTPUT_SIZE: 50_000, // 50KB
  MAX_CODE_LENGTH: 5000, // Characters (updated to match actual usage)
  CLEANUP_INTERVAL: 5 * 60 * 1000, // 5 minutes
  CONTAINER_MAX_AGE: 15 * 60 * 1000, // 15 minutes
} as const;

export const THROTTLE = {
  // Global per-IP backstop enforced by the app-wide ThrottlerGuard. Generous on
  // purpose: one dashboard view fires many API calls, so this exists to blunt
  // floods/DoS — not to police normal navigation. Sensitive routes tighten it
  // with per-route @Throttle overrides using the tiers below.
  GLOBAL: { ttl: 60_000, limit: 300 }, // 300 requests per minute per IP
  DEFAULT: { ttl: 60_000, limit: 5 }, // 5 requests per minute (hardened from 10)
  STRICT: { ttl: 60_000, limit: 3 }, // 3 requests per minute for expensive operations
  AUTH: { ttl: 300_000, limit: 5 }, // 5 auth attempts per 5 minutes (prevents brute force)
  PAYMENTS: { ttl: 60_000, limit: 3 }, // 3 payment initializations per minute
  FILE_UPLOAD: { ttl: 60_000, limit: 3 }, // 3 uploads per minute
} as const;

export const UPLOAD_FOLDERS = ['thumbnails', 'profiles', 'resources'] as const;
export type UploadFolder = (typeof UPLOAD_FOLDERS)[number];

/**
 * Storage key prefixes that are safe to serve through the public media proxy
 * (`GET /media/public/:folder/:filename`). Every folder here is uploaded with
 * `visibility: 'public'` today (see `StorageService.upload` callers) — private
 * folders (e.g. `books`, OMR sheet scans) are deliberately excluded so they
 * can only ever be reached via a purchase/ownership-gated signed URL.
 */
export const PUBLIC_MEDIA_FOLDERS = [
  'images',
  'thumbnails',
  'profiles',
  'resources',
  'attachments',
] as const;
export type PublicMediaFolder = (typeof PUBLIC_MEDIA_FOLDERS)[number];

// Video platform types
export const VIDEO_PLATFORMS = {
  BUNNY: 'bunny',
  VIMEO: 'vimeo', // Legacy support during migration
} as const;

export type VideoPlatform =
  (typeof VIDEO_PLATFORMS)[keyof typeof VIDEO_PLATFORMS];

// URL validation patterns
export const VIDEO_URL_PATTERNS = {
  // Bunny.net Stream embed URLs
  // Matches: https://iframe.mediadelivery.net/embed/123456/abc-def-ghi
  // Matches: https://player.mediadelivery.net/embed/123456/abc-def-ghi
  BUNNY:
    /^https?:\/\/(?:iframe|player)\.mediadelivery\.net\/embed\/(\d+)\/([a-z0-9-]+)/i,

  // Legacy Vimeo URL patterns (for backward compatibility)
  VIMEO:
    /^https?:\/\/(www\.)?(vimeo\.com|player\.vimeo\.com)\/(video\/)?(\d+|channels\/[\w-]+\/\d+|groups\/[\w-]+\/videos\/\d+)/i,
} as const;

// Bunny.net Stream constants
export const BUNNY_STREAM = {
  EMBED_BASE_URL: 'https://iframe.mediadelivery.net/embed',
  PLAYER_BASE_URL: 'https://player.mediadelivery.net/embed',
  API_BASE_URL: 'https://video.bunnycdn.com/library',
} as const;
