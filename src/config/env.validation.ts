import { plainToInstance, Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

import { validateProductionPublicOrigins } from './public-url.util';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsOptional()
  public NODE_ENV: Environment = Environment.Development;

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

  @IsString()
  @IsOptional()
  public PROCESS_ROLE?: string;

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

  // Bull Board dashboard credentials (HTTP Basic Auth for /admin/queues).
  // When unset the dashboard fails closed and rejects all requests.
  @IsString()
  @IsOptional()
  public BULL_BOARD_USER?: string;

  @IsString()
  @IsOptional()
  @MinLength(12)
  public BULL_BOARD_PASSWORD?: string;

  // Firebase (optional - for SMS notifications)
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

  // Bunny.net Stream (video hosting)
  @IsString()
  @IsOptional()
  public BUNNY_STREAM_LIBRARY_ID?: string;

  // Library API key for Stream operations (create/upload/delete video). Accepts
  // either name; BUNNY_API_KEY is used when BUNNY_STREAM_API_KEY is unset.
  @IsString()
  @IsOptional()
  public BUNNY_STREAM_API_KEY?: string;

  @IsString()
  @IsOptional()
  public BUNNY_API_KEY?: string;

  // Pull-zone hostname for Bunny Stream HLS playback + posters,
  // e.g. "vz-xxxxxxxx-xxx.b-cdn.net". Optional: when unset, the iframe embed
  // URL is used for playback and Bunny posters are not stored.
  @IsString()
  @IsOptional()
  public BUNNY_STREAM_CDN_HOSTNAME?: string;

  @IsString()
  @IsOptional()
  public BUNNY_STREAM_PULL_ZONE?: string;

  // Library "Token Authentication Key" used to sign short-lived playback URLs
  // (distinct from the API key). Required for secure video streaming; when
  // unset, the signed-url endpoint returns 503.
  @IsString()
  @IsOptional()
  public BUNNY_STREAM_TOKEN_KEY?: string;

  // Paymob payment gateway (optional until payment features go live).
  @IsString()
  @IsOptional()
  public PAYMOB_API_KEY?: string;

  @IsString()
  @IsOptional()
  public PAYMOB_SECRET_KEY?: string;

  @IsString()
  @IsOptional()
  public PAYMOB_CARD_INTEGRATION_ID?: string;

  @IsString()
  @IsOptional()
  public PAYMOB_IFRAME_ID?: string;

  @IsString()
  @IsOptional()
  public PAYMOB_WEBHOOK_SECRET?: string;

  @IsString()
  @IsOptional()
  public PAYMOB_BASE_URL?: string;

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

  // SMTP / Email delivery (optional — when unset, password-reset emails are
  // logged instead of sent, and the reset token is returned in the response in
  // non-production environments so the flow remains testable).
  @IsString()
  @IsOptional()
  public MAIL_PROVIDER?: string;

  @IsString()
  @IsOptional()
  public MAILERSEND_API_KEY?: string;

  @IsString()
  @IsOptional()
  public MAIL_FROM_EMAIL?: string;

  @IsString()
  @IsOptional()
  public MAIL_FROM_NAME?: string;

  @IsString()
  @IsOptional()
  public MAIL_REPLY_TO?: string;

  @IsString()
  @IsOptional()
  public MAILERSEND_TEMPLATE_WELCOME?: string;

  @IsString()
  @IsOptional()
  public MAILERSEND_TEMPLATE_PASSWORD_RESET?: string;

  @IsString()
  @IsOptional()
  public MAILERSEND_TEMPLATE_LOGIN_VERIFICATION?: string;

  @IsString()
  @IsOptional()
  public MAILERSEND_TEMPLATE_INVITATION?: string;

  @IsString()
  @IsOptional()
  public MAILERSEND_TEMPLATE_PAYMENT_CONFIRMATION?: string;

  @IsString()
  @IsOptional()
  public MAILERSEND_TEMPLATE_INVOICE?: string;

  @IsString()
  @IsOptional()
  public MAILERSEND_TEMPLATE_CERTIFICATE?: string;

  @IsString()
  @IsOptional()
  public MAILERSEND_TEMPLATE_HOMEWORK?: string;

  @IsString()
  @IsOptional()
  public MAILERSEND_TEMPLATE_EXAM?: string;

  @IsString()
  @IsOptional()
  public MAILERSEND_TEMPLATE_SUBSCRIPTION?: string;

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
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
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

  validateProductionPublicOrigins(config);

  if (validatedConfig.NODE_ENV === Environment.Production) {
    for (const key of ['PAYMENT_CAPTURE_GRACE_SECONDS', 'PAYMENT_PROVIDER_CLOCK_SKEW_SECONDS']) {
      if (config[key] === undefined || config[key] === '') {
        throw new Error(
          `Environment validation failed: ${key} must be explicitly configured in production.`,
        );
      }
    }
  }

  return validatedConfig;
}
