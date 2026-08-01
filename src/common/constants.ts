export const FILE_LIMITS = {
  PROFILE_PICTURE_MAX_SIZE: 5 * 1024 * 1024, // 5MB
  THUMBNAIL_MAX_SIZE: 5 * 1024 * 1024, // 5MB
  // Lesson videos are proxied through this server (multer memoryStorage) and
  // relayed to Bunny Stream as a single buffered PUT — see
  // bunny-stream.service.ts / lessons.service.ts:uploadBunnyVideo. The whole
  // file must fit in this process's RAM for the duration of the request, so
  // this is a real capacity ceiling, not an arbitrary one: 20GB comfortably
  // covers a 12-hour lesson even at a generous ~5 Mbps bitrate (~27GB would be
  // the higher end at that bitrate; tune this constant — and the deployment's
  // available RAM — if longer/higher-bitrate lessons are routinely expected).
  // It also remains a deliberate finite backstop against an authenticated
  // teacher account being used to stream an effectively unbounded body at the
  // server (DoS via memory exhaustion) — auth/role guards run before this
  // limit is even reached, so unauthenticated requests never get this far.
  VIDEO_MAX_SIZE: 20 * 1024 * 1024 * 1024, // 20GB
  RESOURCE_MAX_SIZE: 500 * 1024 * 1024, // 500MB
  // Support evidence is deliberately smaller than course resources because
  // Multer buffers uploads in process memory.
  CALL_CENTER_ATTACHMENT_MAX_SIZE: 10 * 1024 * 1024, // 10MB
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
  // TEMPORARY: TestSprite exercises many login scenarios from one IP. Restore
  // `THROTTLE.AUTH` on AuthController.login before the next production deploy.
  LOGIN_TESTSPRITE_TEMPORARY: { ttl: 60_000, limit: 150 },
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
export const PUBLIC_MEDIA_FOLDERS = ['images', 'thumbnails', 'profiles'] as const;
export type PublicMediaFolder = (typeof PUBLIC_MEDIA_FOLDERS)[number];
