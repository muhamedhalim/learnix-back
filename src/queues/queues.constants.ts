import { processEnvReader, resolveRedisUrl } from '../common/utils/redis-connection.util';

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
  /** Payment webhook fulfillment */
  WEBHOOK_FULFILLMENT: 'webhook-fulfillment',

  /** Email notifications (confirmations, alerts) */
  EMAIL: 'email',

  /** Image processing (resize, compress, optimize) */
  IMAGE_PROCESSING: 'image-processing',

  /** File cleanup (orphaned files, expired data) */
  FILE_CLEANUP: 'file-cleanup',

  /** Attendance-code batch generation (1–100,000 codes per batch) */
  CODE_GENERATION: 'code-generation',

  /** Attendance-code exports (CSV/Excel/PDF/JSON/QR) generated off-request */
  CODE_EXPORT: 'code-export',

  /** Auto-submit exam attempts once their server-side deadline passes. */
  EXAM_AUTO_SUBMIT: 'exam-auto-submit',

  /** AI-assisted grading suggestions for manual (essay/file) answers. */
  EXAM_AI_GRADING: 'exam-ai-grading',

  /** OMR / bubble-sheet scan processing (image pipeline). */
  EXAM_OMR: 'exam-omr',

  /** Exam analytics aggregation (stats, difficulty/discrimination indices). */
  EXAM_ANALYTICS: 'exam-analytics',

  /** Gamification maintenance (streak-reset sweep, leaderboard rebuild). */
  GAMIFICATION: 'gamification',

  /** Outbound guardian messages (WhatsApp/SMS) rendered from domain events. */
  PARENT_NOTIFICATIONS: 'parent-notifications',

  /**
   * Terminal parking lot for guardian messages that exhausted every retry.
   * Nothing consumes it — it exists so a permanently-failed message stays
   * visible in Bull Board and can be replayed by an admin rather than vanishing.
   */
  PARENT_NOTIFICATIONS_DLQ: 'parent-notifications-dlq',

  /** Scheduled weekly/monthly guardian progress reports. */
  PARENT_REPORTS: 'parent-reports',
} as const;

/**
 * Job Types within each queue
 */
export const JOB_TYPES = {
  WEBHOOK: {
    FULFILL_PAYMENT: 'fulfill-payment',
  },
  EMAIL: {
    /** Outbound MailerSend delivery; executed only by MailProcessor. */
    DELIVER: 'deliver-email',
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
  CODE: {
    GENERATE_BATCH: 'generate-batch',
  },
  EXPORT: {
    /** One job type per format (dispatched by the export processor). */
    CSV: 'export-csv',
    EXCEL: 'export-excel',
    PDF: 'export-pdf',
    JSON: 'export-json',
    QR: 'export-qr',
    /** Remove expired cached export files. */
    CLEANUP: 'export-cleanup',
  },
  EXAM: {
    /** Finalise a single attempt whose deadline elapsed (delayed per-attempt job). */
    AUTO_SUBMIT: 'auto-submit-attempt',
    /** Sweep for any expired IN_PROGRESS attempts (repeatable safety-net job). */
    AUTO_SUBMIT_SWEEP: 'auto-submit-sweep',
    /** Produce an AI-suggested score/feedback for one manual answer. */
    AI_GRADE_ANSWER: 'ai-grade-answer',
    /** Process one uploaded OMR sheet through the CV pipeline. */
    OMR_PROCESS_SHEET: 'omr-process-sheet',
    /** Recompute aggregated analytics for an exam after a grade change. */
    AGGREGATE_ANALYTICS: 'aggregate-exam-analytics',
  },
  GAMIFICATION: {
    /** Nightly repeatable: zero streaks for students who missed a day. */
    STREAK_RESET_SWEEP: 'streak-reset-sweep',
  },
  PARENT: {
    /** Fan one domain event out to every eligible guardian and deliver it. */
    DELIVER: 'deliver-parent-message',
    /** Re-attempt a single previously-failed `parent_messages` row. */
    REDELIVER: 'redeliver-parent-message',
  },
  PARENT_REPORT: {
    /** Repeatable: enqueue a digest for every student with a verified guardian. */
    WEEKLY_SWEEP: 'weekly-report-sweep',
    MONTHLY_SWEEP: 'monthly-report-sweep',
    /** Build + deliver one student's digest. */
    BUILD: 'build-parent-report',
  },
} as const;

/**
 * Whether BullMQ queues should actually connect to Redis.
 *
 * Read directly from `process.env` (not `ConfigService`) because this is
 * consulted from static `@Module()` `imports` arrays — evaluated at class
 * definition time, before Nest's DI container exists. Production is the only
 * environment where this may legitimately be relied upon to be `true`: the
 * `BullModule.forRootAsync` factory in `queues.module.ts` throws at boot if
 * `NODE_ENV=production` and Redis isn't configured, so by the time any
 * consuming module asks, production has already failed fast one way or the
 * other. In development, `false` means every queue registered via
 * `registerQueues` (see `register-queues.util.ts`) becomes a `NoopQueue`
 * instead of a real Redis-backed queue — see that file for why.
 */
export function areQueuesEnabled(): boolean {
  // The HTTP E2E suite repeatedly truncates and reseeds PostgreSQL. Running
  // BullMQ workers against that same database makes the suite race background
  // jobs and prevents deterministic teardown. Keep Redis-backed cache,
  // throttling, and idempotency enabled while suppressing only workers when
  // the test runner explicitly opts out. This switch is deliberately ignored
  // outside NODE_ENV=test so it cannot disable production processing.
  if (
    process.env['NODE_ENV'] === 'test' &&
    process.env['E2E_DISABLE_BACKGROUND_WORKERS'] === 'true'
  ) {
    return false;
  }

  return resolveRedisUrl(processEnvReader()) !== undefined;
}

/**
 * Default Queue Configuration
 * Applied to all queues unless overridden. Connection is intentionally not
 * part of this: it's supplied once, at the shared default, by
 * `BullModule.forRootAsync` in `queues.module.ts` — every `registerQueue`
 * call inherits it automatically unless it specifies its own override, which
 * none of ours do.
 */
export const DEFAULT_QUEUE_CONFIG = {
  /** Job retry configuration */
  defaultJobOptions: {
    /** Number of retry attempts (QUEUE_DEFAULT_ATTEMPTS, legacy QUEUE_MAX_ATTEMPTS, default 3). */
    attempts: Number.parseInt(
      process.env['QUEUE_DEFAULT_ATTEMPTS'] ?? process.env['QUEUE_MAX_ATTEMPTS'] ?? '3',
      10,
    ),

    /** Exponential backoff base delay (QUEUE_BACKOFF_MS, legacy QUEUE_BACKOFF_DELAY, default 5000ms). */
    backoff: {
      type: 'exponential' as const,
      delay: Number.parseInt(
        process.env['QUEUE_BACKOFF_MS'] ?? process.env['QUEUE_BACKOFF_DELAY'] ?? '5000',
        10,
      ),
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
  /** Concurrent jobs per worker (WORKER_CONCURRENCY, legacy QUEUE_CONCURRENCY, default 5). */
  concurrency: Number.parseInt(
    process.env['WORKER_CONCURRENCY'] ?? process.env['QUEUE_CONCURRENCY'] ?? '5',
    10,
  ),
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
      timeout: 60_000, // 60 seconds
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

  [QUEUE_NAMES.CODE_GENERATION]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      priority: 4,
      // Generation is idempotent per-batch (guarded by batch status); a single
      // attempt avoids duplicate partial runs on transient Redis hiccups.
      attempts: 1,
    },
  },

  [QUEUE_NAMES.CODE_EXPORT]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      priority: 4,
      // Exports rebuild the whole file on retry; allow a couple of attempts for
      // transient I/O errors without piling up partial files.
      attempts: 2,
    },
  },

  [QUEUE_NAMES.EXAM_AUTO_SUBMIT]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      // Timing-critical: finalising an attempt is idempotent (guarded by state),
      // so a few retries on transient DB errors are safe.
      priority: 1,
      attempts: 3,
    },
  },

  [QUEUE_NAMES.EXAM_AI_GRADING]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      // Advisory suggestions; may call an external model → longer timeout.
      priority: 3,
      timeout: 60_000,
    },
  },

  [QUEUE_NAMES.EXAM_OMR]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      // Image processing is heavy; retry a few times on transient failures.
      priority: 3,
      attempts: 3,
      timeout: 120_000,
    },
  },

  [QUEUE_NAMES.EXAM_ANALYTICS]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      // Non-urgent recomputation; a later job supersedes an earlier one.
      priority: 5,
      attempts: 3,
    },
  },

  [QUEUE_NAMES.GAMIFICATION]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      // Idempotent maintenance; the next repeat supersedes a missed run.
      priority: 5,
      attempts: 1,
    },
  },

  [QUEUE_NAMES.PARENT_NOTIFICATIONS]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      // A parent waiting on their child's exam result is user-visible: high
      // priority. Delivery is guarded by a UNIQUE idempotency key per
      // (event, subject, guardian), so a retry can never double-send.
      priority: 2,
      attempts: 5,
      backoff: { type: 'exponential' as const, delay: 10_000 },
      // Keep the full trail: failed guardian messages are an operational
      // concern, not noise.
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  },

  [QUEUE_NAMES.PARENT_NOTIFICATIONS_DLQ]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      // Nothing processes this queue; jobs sit here for inspection/replay.
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    },
  },

  [QUEUE_NAMES.PARENT_REPORTS]: {
    ...DEFAULT_QUEUE_CONFIG,
    defaultJobOptions: {
      ...DEFAULT_QUEUE_CONFIG.defaultJobOptions,
      // Digests are not urgent and the next scheduled run supersedes a miss.
      priority: 5,
      attempts: 3,
    },
  },
};
