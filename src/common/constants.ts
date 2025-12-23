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
  MAX_OUTPUT_SIZE: 50000, // 50KB maximum output
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
  CONTAINER_TIMEOUT: 10000, // 10 seconds
  MAX_OUTPUT_SIZE: 50000, // 50KB
  MAX_CODE_LENGTH: 5000, // Characters (updated to match actual usage)
  CLEANUP_INTERVAL: 5 * 60 * 1000, // 5 minutes
  CONTAINER_MAX_AGE: 15 * 60 * 1000, // 15 minutes
} as const;

export const THROTTLE = {
  DEFAULT: { ttl: 60000, limit: 5 }, // 5 requests per minute (hardened from 10)
  STRICT: { ttl: 60000, limit: 3 }, // 3 requests per minute for expensive operations
  AUTH: { ttl: 300000, limit: 5 }, // 5 auth attempts per 5 minutes (prevents brute force)
  PAYMENTS: { ttl: 60000, limit: 3 }, // 3 payment initializations per minute
  FILE_UPLOAD: { ttl: 60000, limit: 3 }, // 3 uploads per minute
} as const;

export const UPLOAD_FOLDERS = ['thumbnails', 'profiles', 'resources'] as const;
export type UploadFolder = (typeof UPLOAD_FOLDERS)[number];
