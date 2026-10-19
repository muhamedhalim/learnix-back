import { plainToInstance, Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

import { decodeSecretBoxKey, SecretBoxKeyError } from '../common/utils/secret-box.util';
import { recordReader, resolveAppEnv } from './app-env';
import { assertEnvironmentIsolation } from './environment-isolation.guard';
import { validateProductionPublicOrigins } from './public-url.util';
import { resolveDatabaseSsl } from '../common/utils/database-ssl.util';
import { resolveRedisUrl } from '../common/utils/redis-connection.util';
import { resolveKeepAliveTimeouts, resolveLogFormat, resolveTrustProxyHops } from './http-runtime';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

const PUBLIC_MAILBOX_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
]);

const EASYKASH_ALLOWED_HOSTS = new Set(['back.easykash.net']);
const EASYKASH_PAYMENT_OPTION_IDS = new Set([
  1, 2, 3, 4, 5, 6, 8, 9, 10, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 34,
  35,
]);

export function validateEasyKashBaseUrl(value: unknown): void {
  if (value === undefined || value === '') return;
  if (typeof value !== 'string') throw new Error('EASYKASH_API_BASE_URL must be a URL.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('EASYKASH_API_BASE_URL must be a valid HTTPS EasyKash URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    !EASYKASH_ALLOWED_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error(
      'EASYKASH_API_BASE_URL must use an allowlisted HTTPS EasyKash host without credentials, path, query, or fragment.',
    );
  }
}

export function validateEasyKashPaymentOptions(value: unknown): void {
  if (value === undefined || value === '') return;
  if (typeof value !== 'string') throw new Error('EASYKASH_PAYMENT_OPTIONS must be a list.');
  for (const part of value.split(',')) {
    const id = Number(part.trim());
    if (!Number.isInteger(id) || !EASYKASH_PAYMENT_OPTION_IDS.has(id)) {
      throw new Error(
        'EASYKASH_PAYMENT_OPTIONS must be a comma-separated list of documented EasyKash payment option ids.',
      );
    }
  }
}

/** When any EasyKash setting is present, the credentials and public origin must all be too. */
export function validateEasyKashConfiguration(config: Record<string, unknown>): void {
  const present = (key: string): boolean => {
    const value = config[key];
    return typeof value === 'string' && value.trim() !== '';
  };
  const gatewayKeys = ['EASYKASH_API_KEY', 'EASYKASH_HMAC_SECRET'];
  const optionalKeys = [
    'EASYKASH_API_BASE_URL',
    'EASYKASH_PAYMENT_OPTIONS',
    'EASYKASH_CASH_EXPIRY_HOURS',
  ];
  if (![...gatewayKeys, ...optionalKeys].some(present)) return;
  for (const key of [...gatewayKeys, 'BACKEND_URL']) {
    if (!present(key)) {
      throw new Error(
        `Environment validation failed: ${key} is required when EasyKash is configured.`,
      );
    }
  }
  if (present('EASYKASH_CASH_EXPIRY_HOURS')) {
    const hours = Number(config['EASYKASH_CASH_EXPIRY_HOURS']);
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) {
      throw new Error('EASYKASH_CASH_EXPIRY_HOURS must be an integer between 1 and 72.');
    }
  }
}

/**
 * With REQUIRE_TLS_BACKENDS=true (set in the AWS environments) the app refuses to boot on
 * plaintext Redis or an unverified database certificate, instead of silently running unencrypted.
 */
export function validateTlsBackends(config: Record<string, unknown>): void {
  const read = recordReader(config);
  if (read('REQUIRE_TLS_BACKENDS') !== 'true') return;

  const redisUrl = resolveRedisUrl(read);
  if (redisUrl !== undefined && !redisUrl.toLowerCase().startsWith('rediss://')) {
    throw new Error('REQUIRE_TLS_BACKENDS=true: the Redis URL must use rediss:// (TLS).');
  }
  if (read('SSL_REJECT_UNAUTHORIZED') === 'false') {
    throw new Error('REQUIRE_TLS_BACKENDS=true: SSL_REJECT_UNAUTHORIZED=false is not allowed.');
  }
  const databaseUrl = read('DATABASE_URL');
  if (databaseUrl !== undefined && resolveDatabaseSsl(databaseUrl, read) === false) {
    throw new Error(
      'REQUIRE_TLS_BACKENDS=true: DATABASE_URL points at a loopback host, which is not TLS-protected.',
    );
  }
}

/**
 * AWS runtime profile (staging and production on ECS, recognised by S3_BUCKET + APP_ENV). These variables are
 * read ad hoc by their modules, where a typo silently disables a feature or falls back to a legacy provider.
 * Failing the boot is cheaper than discovering it from a missing e-mail or an SMS that never left.
 */
export function validateAwsRuntimeProfile(config: Record<string, unknown>): void {
  const read = recordReader(config);
  const appEnv = read('APP_ENV')?.trim().toLowerCase();
  if (!read('S3_BUCKET') || (appEnv !== 'staging' && appEnv !== 'production')) return;

  const oneOf = (key: string, allowed: string[]): void => {
    const value = read(key)?.trim().toLowerCase();
    if (value && !allowed.includes(value)) {
      throw new Error(
        `Environment validation failed: ${key}=${value} is not one of ${allowed.join(', ')}.`,
      );
    }
  };
  oneOf('MAIL_PROVIDER', ['ses']);
  oneOf('SMS_PROVIDER', ['aws', 'twilio']);
  // Anything but "webpush" silently selects FCM in the notifications module.
  oneOf('PUSH_PROVIDER', ['webpush', 'fcm']);

  for (const key of ['MEDIA_EVENTS_QUEUE_URL', 'MAIL_EVENTS_QUEUE_URL', 'SMS_EVENTS_QUEUE_URL']) {
    const value = read(key);
    if (
      value &&
      !/^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_.-]+$/.test(value)
    ) {
      throw new Error(`Environment validation failed: ${key} must be an SQS queue URL.`);
    }
  }

  // SES can only DKIM-sign for a domain it has verified, so a mailbox-provider sender (for example gmail.com)
  // fails SPF/DKIM alignment and is spam-foldered or rejected under that provider's DMARC policy.
  const fromDomain = read('MAIL_FROM_EMAIL')?.trim().toLowerCase().split('@')[1];
  if (
    read('MAIL_PROVIDER')?.trim().toLowerCase() === 'ses' &&
    fromDomain !== undefined &&
    PUBLIC_MAILBOX_DOMAINS.has(fromDomain)
  ) {
    throw new Error(
      `Environment validation failed: MAIL_FROM_EMAIL uses ${fromDomain}; SES must send from a verified domain the platform owns.`,
    );
  }

  // Legacy storage providers stay selectable in code for rollback until the parity window ends; production on
  // AWS must not pick one up by accident from a stale variable.
  if (appEnv === 'production' && read('LEGACY_PROVIDERS_ALLOWED') !== 'true') {
    const legacy = ['R2_ACCOUNT_ID', 'R2_BUCKET'].filter((key) => read(key));
    if (legacy.length > 0) {
      throw new Error(
        `Environment validation failed: ${legacy.join(', ')} select a legacy storage provider; unset them or set LEGACY_PROVIDERS_ALLOWED=true.`,
      );
    }
  }
}

export class EnvironmentVariables {
  @IsOptional()
  public NODE_ENV: Environment = Environment.Development;

  /**
   * Deployment identity, independent of `NODE_ENV`'s behaviour switches.
   * Optional and derived from `NODE_ENV` when absent, so existing deployments
   * are unaffected. Semantic validation lives in `resolveAppEnv` (see
   * `app-env.ts`), which produces a far better message than a generic
   * enum-constraint failure would.
   */
  @IsString()
  @IsOptional()
  public APP_ENV?: string;

  /** When `true`, `APP_ENV` must be supplied explicitly rather than derived. */
  @IsString()
  @IsOptional()
  public APP_ENV_STRICT?: string;

  // --- Cross-environment isolation inputs (see environment-isolation.guard.ts) ---
  // All optional: the guard ships with protective defaults and these extend them.

  /** Extra exact hostnames belonging to production. Comma-separated. */
  @IsString()
  @IsOptional()
  public PROD_HOST_DENYLIST?: string;

  /** Extra production resource identifiers (bucket names, library IDs, DB names). */
  @IsString()
  @IsOptional()
  public PROD_IDENTIFIER_DENYLIST?: string;

  /** Combined alias accepted for both host and identifier denylists. */
  @IsString()
  @IsOptional()
  public PROD_RESOURCE_DENYLIST?: string;

  /** Extra production sender addresses that staging must not send from. */
  @IsString()
  @IsOptional()
  public PROD_SENDER_DENYLIST?: string;

  /**
   * SHA-256 fingerprints (first 16 hex chars) of production secrets. Only
   * hashes are stored, never values, so a production credential can be
   * blocked from staging without being written down anywhere.
   */
  @IsString()
  @IsOptional()
  public PROD_SECRET_FINGERPRINTS?: string;

  /** Optional Redis key namespace; must be staging-marked on staging. */
  @IsString()
  @IsOptional()
  public REDIS_NAMESPACE?: string;

  /**
   * Staging-only outbound mail allowlist (addresses or bare domains).
   * Required on staging whenever SES is configured; forbidden on
   * production, where it would silently discard customer mail.
   */
  @IsString()
  @IsOptional()
  public MAIL_ALLOWLIST?: string;

  /** Staging-only: `sandbox` suppresses real SMS/WhatsApp delivery. */
  @IsIn(['sandbox', 'live'])
  @IsOptional()
  public SMS_MODE?: 'sandbox' | 'live';

  /**
   * Never set in this codebase — cookies are host-only, which is what keeps
   * environments from sharing credentials. Declared so the isolation guard can
   * reject it if it is ever introduced with a shared parent domain.
   */
  @IsString()
  @IsOptional()
  public COOKIE_DOMAIN?: string;

  @IsNumber()
  @Min(1000)
  @Max(65_535)
  @IsOptional()
  @Type(() => Number)
  public PORT = 3000;

  // Database
  @IsNotEmpty()
  public DATABASE_URL!: string;

  // TypeORM
  @IsString()
  @IsOptional()
  public TYPEORM_SYNCHRONIZE?: string;

  // Database connection pool tuning (optional; sensible defaults applied).
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public DB_POOL_MAX?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public DB_POOL_MIN?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public DB_POOL_IDLE_TIMEOUT_MS?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public DB_POOL_CONNECTION_TIMEOUT_MS?: number;

  // WhatsApp — Meta Cloud API. All optional: when unset the WhatsApp channel
  // reports itself unconfigured and the registry falls back to SMS.
  @IsString()
  @IsOptional()
  public META_WHATSAPP_PHONE_NUMBER_ID?: string;

  @IsString()
  @IsOptional()
  public META_WHATSAPP_ACCESS_TOKEN?: string;

  /** Used to verify the `X-Hub-Signature-256` HMAC on delivery webhooks. */
  @IsString()
  @IsOptional()
  public META_WHATSAPP_APP_SECRET?: string;

  /** Echoed back during Meta's one-time webhook subscription handshake. */
  @IsString()
  @IsOptional()
  public META_WHATSAPP_VERIFY_TOKEN?: string;

  // Redis (optional for development - falls back to in-memory)
  @IsString()
  @IsOptional()
  public REDIS_HOST?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public REDIS_PORT?: number;

  @IsString()
  @IsOptional()
  public REDIS_PASSWORD?: string;

  // Redis connection URL (used by the idempotency service).
  @IsString()
  @IsOptional()
  public REDIS_URL?: string;

  @IsIn(['all', 'api', 'worker'])
  @IsOptional()
  public PROCESS_ROLE?: string;

  // Runtime behind CloudFront + ALB (semantic checks live in http-runtime.ts / validate()).
  @IsString()
  @IsOptional()
  public TRUST_PROXY_HOPS?: string;

  @IsString()
  @IsOptional()
  public HTTP_KEEP_ALIVE_TIMEOUT_MS?: string;

  @IsString()
  @IsOptional()
  public LOG_FORMAT?: string;

  /** Extra CA for the database certificate: PEM text or a file path (Amazon RDS bundle). */
  @IsString()
  @IsOptional()
  public DATABASE_SSL_CA?: string;

  @IsString()
  @IsOptional()
  public DATABASE_SSL_CA_FILE?: string;

  // Amazon S3 object storage. Credentials come from the task role; the key/endpoint variables are
  // for local S3-compatible testing only and are rejected in production (see StorageService).
  @IsString()
  @IsOptional()
  public S3_BUCKET?: string;

  @IsString()
  @IsOptional()
  public S3_REGION?: string;

  @IsString()
  @IsOptional()
  public S3_ENDPOINT?: string;

  @IsString()
  @IsOptional()
  public S3_ACCESS_KEY_ID?: string;

  @IsString()
  @IsOptional()
  public S3_SECRET_ACCESS_KEY?: string;

  @IsString()
  @IsOptional()
  public S3_FORCE_PATH_STYLE?: string;

  /** Private bucket MediaConvert reads lesson videos from (direct uploads, purpose lesson_video). */
  @IsString()
  @IsOptional()
  public VIDEO_SOURCE_BUCKET?: string;

  /** `true` makes boot fail unless Redis uses rediss:// and the database certificate is verified. */
  @IsString()
  @IsOptional()
  public REQUIRE_TLS_BACKENDS?: string;

  @IsString()
  @IsOptional()
  public HEALTH_COLLECTOR_PROCESS_ROLE?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public HEALTH_COLLECTOR_CADENCE_SECONDS?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public HEALTH_COLLECTOR_LOCK_TTL_MS?: number;

  // BullMQ tuning (fall back to legacy QUEUE_MAX_ATTEMPTS/QUEUE_BACKOFF_DELAY/
  // QUEUE_CONCURRENCY names when these are unset — see queues.constants.ts).
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public QUEUE_DEFAULT_ATTEMPTS?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public QUEUE_BACKOFF_MS?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public WORKER_CONCURRENCY?: number;

  // JWT Authentication
  @IsNotEmpty()
  @MinLength(32)
  public JWT_SECRET!: string;

  @IsString()
  @IsOptional()
  public JWT_EXPIRATION?: string;

  @IsNotEmpty()
  @MinLength(32)
  public JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsOptional()
  public JWT_REFRESH_EXPIRATION?: string;

  // Admin Initialization
  @IsString()
  @IsOptional()
  @MinLength(32)
  public COOKIE_SECRET?: string;

  @IsString()
  @IsOptional()
  public CORS_ORIGINS?: string;

  @IsString()
  @IsOptional()
  @MinLength(32)
  public INIT_SECRET?: string;

  @IsString()
  @IsOptional()
  public ADMIN_INIT_EMAIL?: string;

  @IsString()
  @IsOptional()
  @MinLength(16)
  public ADMIN_INIT_PASSWORD?: string;

  // Monitoring / Sentry (optional; error monitoring disabled when DSN unset).
  @IsString()
  @IsOptional()
  public SENTRY_DSN?: string;

  /**
   * Operator kill-switch. Exactly `'false'` prevents Sentry from initialising
   * even when a DSN is present (see `observability/sentry.ts`). Any other
   * value leaves the DSN-only behaviour unchanged.
   */
  @IsString()
  @IsOptional()
  public SENTRY_ENABLED?: string;

  @IsString()
  @IsOptional()
  public SENTRY_RELEASE?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public SENTRY_TRACES_SAMPLE_RATE?: number;

  /**
   * Human-readable build version. Also the second-choice release identifier
   * after `SENTRY_RELEASE` (see `observability/release.ts`); when neither is
   * set the platform commit SHA is used, so releases are tagged by default.
   */
  @IsString()
  @IsOptional()
  public APP_VERSION?: string;

  // --- Operational alert delivery (see health/operational-alert.service.ts) ---
  // Both destinations are optional and independent. With neither set, alerts
  // remain in-app only — i.e. exactly the previous behaviour.

  /** Comma-separated addresses that receive critical operational alerts. */
  @IsString()
  @IsOptional()
  public ALERT_EMAIL_RECIPIENTS?: string;

  /** Provider-agnostic JSON webhook (Slack/Discord-compatible payload). */
  @IsString()
  @IsOptional()
  public ALERT_WEBHOOK_URL?: string;

  @IsNumber()
  @Min(500)
  @Max(30_000)
  @IsOptional()
  @Type(() => Number)
  public ALERT_WEBHOOK_TIMEOUT_MS?: number;

  /** Minimum gap between external deliveries of the SAME incident key. */
  @IsNumber()
  @Min(0)
  @Max(86_400)
  @IsOptional()
  @Type(() => Number)
  public ALERT_MIN_INTERVAL_SECONDS?: number;

  // --- Performance / metrics instrumentation ---
  /** Bearer token required by `GET /metrics`. Endpoint fails closed without it. */
  @IsString()
  @IsOptional()
  public METRICS_BEARER_TOKEN?: string;

  @IsString()
  @IsOptional()
  public PERFORMANCE_HTTP_LOGGING?: string;

  @IsString()
  @IsOptional()
  public PERFORMANCE_QUERY_LOGGING?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public PERFORMANCE_SLOW_QUERY_MS?: number;

  @IsString()
  @IsOptional()
  public LOG_LEVELS?: string;

  // Bull Board dashboard credentials (HTTP Basic Auth for /admin/queues).
  // When unset the dashboard fails closed and rejects all requests.
  @IsString()
  @IsOptional()
  public BULL_BOARD_USER?: string;

  @IsString()
  @IsOptional()
  @MinLength(12)
  public BULL_BOARD_PASSWORD?: string;

  /**
   * Firebase Admin credentials. Optional, and used for exactly two things:
   * verifying Firebase ID tokens at sign-in, and Cloud Messaging — the push
   * transport behind `PushProvider`. When unset, ID-token sign-in and push both
   * report themselves unavailable; nothing else changes.
   *
   * SERVER-ONLY. The browser receives only the public web config, which lives
   * in the frontend's own NEXT_PUBLIC_FIREBASE_* variables.
   */
  @IsString()
  @IsOptional()
  public FIREBASE_PROJECT_ID?: string;

  @IsString()
  @IsOptional()
  public FIREBASE_CLIENT_EMAIL?: string;

  @IsString()
  @IsOptional()
  public FIREBASE_PRIVATE_KEY?: string;

  @IsString()
  @IsOptional()
  public TWILIO_ACCOUNT_SID?: string;

  @IsString()
  @IsOptional()
  public TWILIO_AUTH_TOKEN?: string;

  @IsString()
  @IsOptional()
  public TWILIO_PHONE_NUMBER?: string;

  // EasyKash payment gateway (optional until payment features go live).
  @IsString()
  @IsOptional()
  public EASYKASH_API_KEY?: string;

  @IsString()
  @IsOptional()
  public EASYKASH_HMAC_SECRET?: string;

  @IsString()
  @IsOptional()
  public EASYKASH_API_BASE_URL?: string;

  /** Comma-separated EasyKash Pay API paymentOptions ids. */
  @IsString()
  @IsOptional()
  public EASYKASH_PAYMENT_OPTIONS?: string;

  /** Cash voucher (Fawry/Aman) validity in hours. */
  @IsString()
  @IsOptional()
  public EASYKASH_CASH_EXPIRY_HOURS?: string;

  /** Trusted provider capture time may arrive shortly after local expiry. */
  @IsNumber()
  @Min(0)
  @Max(86_400)
  @IsOptional()
  @Type(() => Number)
  public PAYMENT_CAPTURE_GRACE_SECONDS = 300;

  /** Maximum accepted future clock skew for a provider-issued capture time. */
  @IsNumber()
  @Min(0)
  @Max(3_600)
  @IsOptional()
  @Type(() => Number)
  public PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS = 120;

  // Email delivery through Amazon SES (optional — when unset, password-reset emails are
  // logged instead of sent, and the reset token is returned in the response in
  // non-production environments so the flow remains testable).
  @IsIn(['ses'])
  @IsOptional()
  public MAIL_PROVIDER?: string;

  @IsString()
  @IsOptional()
  public MAIL_FROM_EMAIL?: string;

  @IsString()
  @IsOptional()
  public MAIL_FROM_NAME?: string;

  @IsString()
  @IsOptional()
  public MAIL_REPLY_TO?: string;

  // Password reset token lifetime (duration string, e.g. "1h", "30m"). Default 1h.
  @IsString()
  @IsOptional()
  public PASSWORD_RESET_EXPIRATION?: string;

  // Application URLs
  @IsString()
  @IsOptional()
  public FRONTEND_URL?: string;

  @IsString()
  @IsOptional()
  public BACKEND_URL?: string;

  /** Public origin used for browser-facing URLs from the media proxy. */
  @IsString()
  @IsOptional()
  public PUBLIC_MEDIA_BASE_URL?: string;

  @IsString()
  @IsOptional()
  public CORS_ORIGIN?: string;

  // Security
  @IsNumber()
  @Min(4)
  @Max(20)
  @IsOptional()
  @Type(() => Number)
  public BCRYPT_ROUNDS = 12;

  // File Uploads
  @IsString()
  @IsOptional()
  public UPLOAD_DIR?: string;

  // Lesson Access Settings
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public LESSON_ACCESS_DAYS?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public LESSON_EXTENSION_DAYS?: number;

  // Meeting provider integration (Google Meet / Zoom / Microsoft Teams).
  // Optional: with no key configured, connecting a meeting account reports
  // itself unavailable — the same graceful-degradation shape as MailService
  // and StorageService — rather than the app failing to boot.
  /** Base64-encoded 32-byte AES-256-GCM key encrypting OAuth tokens at rest. */
  @IsString()
  @IsOptional()
  public MEETING_TOKEN_ENCRYPTION_KEY?: string;

  // Marketplace instructor payout accounts (FR-203). Optional in the same
  // graceful-degradation shape: with no key configured,
  // `PayoutAccountService` reports the capability unavailable rather than
  // the app failing to boot. A distinct key from meeting tokens above —
  // bank/wallet identifiers and OAuth tokens have no reason to share one.
  /** Base64-encoded 32-byte AES-256-GCM key encrypting payout account identifiers at rest. */
  @IsString()
  @IsOptional()
  public PAYOUT_ACCOUNT_ENCRYPTION_KEY?: string;

  /** Base URL the OAuth callback is registered under at each provider. Falls back to BACKEND_URL. */
  @IsString()
  @IsOptional()
  public MEETING_OAUTH_REDIRECT_BASE_URL?: string;

  // Google Meet (Phase 4 — first concrete meeting provider). Optional: with
  // either unset, GoogleMeetProvider.isConfigured() reports false and the
  // teacher integrations UI shows Google Meet as "Not available yet".
  @IsString()
  @IsOptional()
  public GOOGLE_MEET_CLIENT_ID?: string;

  @IsString()
  @IsOptional()
  public GOOGLE_MEET_CLIENT_SECRET?: string;

  // Zoom (Phase 6 — second concrete meeting provider). A Zoom Marketplace
  // "General (OAuth)" app; optional, same graceful-degradation shape as
  // Google Meet above.
  @IsString()
  @IsOptional()
  public ZOOM_CLIENT_ID?: string;

  @IsString()
  @IsOptional()
  public ZOOM_CLIENT_SECRET?: string;

  // Microsoft Teams (Phase 7 — third and final concrete meeting provider).
  // An Entra ID (Azure AD) app registration; work/school accounts only
  // (R-2). Optional: with any unset, MicrosoftTeamsProvider.isConfigured()
  // reports false and the teacher integrations UI shows Teams as "Not
  // available yet".
  @IsString()
  @IsOptional()
  public MS_TEAMS_CLIENT_ID?: string;

  @IsString()
  @IsOptional()
  public MS_TEAMS_CLIENT_SECRET?: string;

  @IsString()
  @IsOptional()
  public MS_TEAMS_TENANT?: string;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const read = recordReader(config);

  // Resolve deployment identity first: an unsupported APP_ENV should fail with
  // its own precise message rather than surfacing as a downstream symptom.
  const appEnv = resolveAppEnv(read);

  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const errorMessages = errors
      .map((error) => {
        const constraints = error.constraints
          ? Object.values(error.constraints).join(', ')
          : 'Unknown validation error';
        return `  - ${error.property}: ${constraints}`;
      })
      .join('\n');

    throw new Error(
      `Environment validation failed:\n\n${errorMessages}\n\nPlease check your .env file and ensure all required variables are set correctly.`,
    );
  }

  resolveTrustProxyHops(read);
  resolveKeepAliveTimeouts(read);
  resolveLogFormat(read);
  validateTlsBackends(config);
  validateProductionPublicOrigins(config);
  validateAwsRuntimeProfile(config);
  validateEasyKashBaseUrl(validatedConfig.EASYKASH_API_BASE_URL);
  validateEasyKashPaymentOptions(validatedConfig.EASYKASH_PAYMENT_OPTIONS);
  validateEasyKashConfiguration(config);
  if (validatedConfig.MEETING_TOKEN_ENCRYPTION_KEY) {
    try {
      decodeSecretBoxKey(validatedConfig.MEETING_TOKEN_ENCRYPTION_KEY);
    } catch (error) {
      throw new Error(
        `Environment validation failed: ${error instanceof SecretBoxKeyError ? error.message : 'MEETING_TOKEN_ENCRYPTION_KEY is invalid.'}`,
      );
    }
  }
  if (validatedConfig.PAYOUT_ACCOUNT_ENCRYPTION_KEY) {
    try {
      decodeSecretBoxKey(
        validatedConfig.PAYOUT_ACCOUNT_ENCRYPTION_KEY,
        'PAYOUT_ACCOUNT_ENCRYPTION_KEY',
      );
    } catch (error) {
      throw new Error(
        `Environment validation failed: ${error instanceof SecretBoxKeyError ? error.message : 'PAYOUT_ACCOUNT_ENCRYPTION_KEY is invalid.'}`,
      );
    }
  }

  if (validatedConfig.NODE_ENV === Environment.Production) {
    for (const key of ['PAYMENT_CAPTURE_GRACE_SECONDS', 'PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS']) {
      if (config[key] === undefined || config[key] === '') {
        throw new Error(
          `Environment validation failed: ${key} must be explicitly configured in production.`,
        );
      }
    }
  }

  // Cross-environment isolation. Deliberately last: the checks above establish
  // that the configuration is internally coherent, and this establishes that it
  // belongs to the environment claiming it. Runs before ConfigModule returns,
  // therefore before any module, queue, cron trigger or database connection
  // exists — the only point early enough to stop a misconfigured staging
  // instance from reaching production resources (see the guard's header).
  assertEnvironmentIsolation(appEnv, read);

  return validatedConfig;
}
