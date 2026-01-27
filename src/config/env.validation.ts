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
  @Max(65535)
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

  @IsString()
  @IsOptional()
  public BUNNY_STREAM_API_KEY?: string;

  // Paymob (optional until payment features are implemented)
  @IsString()
  @IsOptional()
  public PAYMOB_API_KEY?: string;

  @IsString()
  @IsOptional()
  public PAYMOB_INTEGRATION_ID?: string;

  @IsString()
  @IsOptional()
  public PAYMOB_IFRAME_ID?: string;

  @IsString()
  @IsOptional()
  public PAYMOB_HMAC_SECRET?: string;

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
