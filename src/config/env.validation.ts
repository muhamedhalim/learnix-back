import { plainToInstance, Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

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
  public JWT_SECRET!: string;

  @IsString()
  @IsOptional()
  public JWT_EXPIRATION?: string;

  @IsNotEmpty()
  public JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsOptional()
  public JWT_REFRESH_EXPIRATION?: string;

  // Admin Initialization
  @IsString()
  @IsOptional()
  public INIT_SECRET?: string;

  @IsString()
  @IsOptional()
  public ADMIN_INIT_EMAIL?: string;

  @IsString()
  @IsOptional()
  public ADMIN_INIT_PASSWORD?: string;

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

  // EasyKash payment gateway (optional until payment features go live).
  // API key used to authenticate outbound create-payment requests.
  @IsString()
  @IsOptional()
  public EASYKASH_API_KEY?: string;

  // Secret used to verify the HMAC signature on inbound EasyKash webhooks.
  @IsString()
  @IsOptional()
  public EASYKASH_HMAC_SECRET?: string;

  // Base URL of the EasyKash API (create-payment endpoint host).
  @IsString()
  @IsOptional()
  public EASYKASH_API_URL?: string;

  // SMTP / Email delivery (optional — when unset, password-reset emails are
  // logged instead of sent, and the reset token is returned in the response in
  // non-production environments so the flow remains testable).
  @IsString()
  @IsOptional()
  public SMTP_HOST?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  public SMTP_PORT?: number;

  @IsString()
  @IsOptional()
  public SMTP_SECURE?: string;

  @IsString()
  @IsOptional()
  public SMTP_USER?: string;

  @IsString()
  @IsOptional()
  public SMTP_PASSWORD?: string;

  @IsString()
  @IsOptional()
  public MAIL_FROM?: string;

  @IsString()
  @IsOptional()
  public MAIL_FROM_NAME?: string;

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

export function validate(
  config: Record<string, unknown>,
): EnvironmentVariables {
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

  return validatedConfig;
}
