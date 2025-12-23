/**
 * Queue Names and Configuration Constants
 *
 * This file centralizes all queue-related constants for the BullMQ job processing system.
 */

/**
 * Queue Names
 * Each queue processes a specific type of background job
 */
export const QUEUE_NAMES = {
  /** Payment webhook fulfillment (Paymob callbacks) */
  WEBHOOK_FULFILLMENT: 'webhook-fulfillment',

  /** Email notifications (confirmations, alerts) */
  EMAIL: 'email',

  /** Image processing (resize, compress, optimize) */
  IMAGE_PROCESSING: 'image-processing',

  /** File cleanup (orphaned files, expired data) */
  FILE_CLEANUP: 'file-cleanup',
} as const;

/**
 * Job Types within each queue
 */
export const JOB_TYPES = {
  WEBHOOK: {
    FULFILL_PAYMENT: 'fulfill-payment',
  },
  EMAIL: {
    PAYMENT_CONFIRMATION: 'payment-confirmation',
    LESSON_PURCHASE_CONFIRMATION: 'lesson-purchase-confirmation',
    PACKAGE_PURCHASE_CONFIRMATION: 'package-purchase-confirmation',
    ACCESS_EXTENDED: 'access-extended',
    ACCESS_EXPIRING: 'access-expiring',
  },
  IMAGE: {
    OPTIMIZE_UPLOAD: 'optimize-upload',
    GENERATE_THUMBNAIL: 'generate-thumbnail',
  },
  FILE: {
    DELETE_FILE: 'delete-file',
    CLEANUP_ORPHANS: 'cleanup-orphans',
  },
} as const;

/**
 * Build Redis connection object from environment variables
 * Returns undefined if Redis is not configured (for development without Redis)
 */
function getRedisConnection() {
  const host = process.env.REDIS_HOST;
  const port = process.env.REDIS_PORT;

  // If no Redis host configured, return minimal config that will fail gracefully
  if (!host) {
    return {
      host: 'localhost',
      port: 6379,
    };
  }

  const password = process.env.REDIS_PASSWORD;

  return {
    host,
    port: port ? parseInt(port, 10) : 6379,
    ...(password && { password }),
  };
}

/**
 * Default Queue Configuration
 * Applied to all queues unless overridden
 */
export const DEFAULT_QUEUE_CONFIG = {
  /** Redis connection options */
  connection: getRedisConnection(),

  /** Job retry configuration */
  defaultJobOptions: {
    /** Number of retry attempts (from env or default 3) */
    attempts: parseInt(process.env.QUEUE_MAX_ATTEMPTS || '3', 10),

    /** Exponential backoff: 5s, 10s, 20s, 40s... */
    backoff: {
      type: 'exponential' as const,
      delay: parseInt(process.env.QUEUE_BACKOFF_DELAY || '5000', 10),
    },

    /** Remove job from queue after completion (keep failed jobs for debugging) */
    removeOnComplete: {
      age: 24 * 3600, // Keep for 24 hours
      count: 1000, // Keep last 1000 jobs
    },

    /** Keep failed jobs for debugging */
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep for 7 days
    },
  },
};

/**
 * Worker Configuration
 * Settings for job processors
 */
export const WORKER_CONFIG = {
  /** Concurrent jobs per worker (from env or default 5) */
  concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '5', 10),

  /** Redis connection (same as queue) */
  connection: DEFAULT_QUEUE_CONFIG.connection,
};

/**
 * Queue-specific overrides
 * Some queues need different settings
 */
export const QUEUE_CONFIGS = {
  [QUEUE_NAMES.WEBHOOK_FULFILLMENT]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      /** Critical jobs - retry more aggressively */
      attempts: 5,
      priority: 1, // Highest priority
    },
  },

  [QUEUE_NAMES.EMAIL]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      priority: 2, // High priority
    },
  },

  [QUEUE_NAMES.IMAGE_PROCESSING]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      priority: 3, // Medium priority
      /** Images can be large - longer timeout */
      timeout: 60000, // 60 seconds
    },
  },

  [QUEUE_NAMES.FILE_CLEANUP]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      priority: 5, // Lowest priority
      attempts: 1, // Don't retry cleanup - run it again next cycle
    },
  },
};
