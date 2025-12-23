import { plainToInstance } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsNumber,
  Min,
  Max,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(Environment)
  @IsOptional()
  NODE_ENV: Environment = Environment.Development;

  @IsNumber()
  @Min(1000)
  @Max(65535)
  @IsOptional()
  PORT: number = 3000;

  // Database
  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  // TypeORM
  @IsString()
  @IsOptional()
  TYPEORM_SYNCHRONIZE?: string;

  // Redis (optional for development - falls back to in-memory)
  @IsString()
  @IsOptional()
  REDIS_HOST?: string;

  @IsNumber()
  @IsOptional()
  REDIS_PORT?: number;

  @IsString()
  @IsOptional()
  REDIS_PASSWORD?: string;

  // JWT Authentication
  @IsString()
  @IsNotEmpty()
  JWT_SECRET!: string;

  @IsString()
  @IsOptional()
  JWT_EXPIRATION?: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsOptional()
  JWT_REFRESH_EXPIRATION?: string;

  // Admin Initialization
  @IsString()
  @IsOptional()
  INIT_SECRET?: string;

  @IsString()
  @IsOptional()
  ADMIN_INIT_EMAIL?: string;

  @IsString()
  @IsOptional()
  ADMIN_INIT_PASSWORD?: string;

  // Firebase (optional - for SMS notifications)
  @IsString()
  @IsOptional()
  FIREBASE_PROJECT_ID?: string;

  @IsString()
  @IsOptional()
  FIREBASE_CLIENT_EMAIL?: string;

  @IsString()
  @IsOptional()
  FIREBASE_PRIVATE_KEY?: string;

  // Vimeo (optional until video features are implemented)
  @IsString()
  @IsOptional()
  VIMEO_ACCESS_TOKEN?: string;

  @IsString()
  @IsOptional()
  VIMEO_CLIENT_ID?: string;

  @IsString()
  @IsOptional()
  VIMEO_CLIENT_SECRET?: string;

  // Paymob (optional until payment features are implemented)
  @IsString()
  @IsOptional()
  PAYMOB_API_KEY?: string;

  @IsString()
  @IsOptional()
  PAYMOB_INTEGRATION_ID?: string;

  @IsString()
  @IsOptional()
  PAYMOB_IFRAME_ID?: string;

  @IsString()
  @IsOptional()
  PAYMOB_HMAC_SECRET?: string;

  // Application URLs
  @IsString()
  @IsOptional()
  FRONTEND_URL?: string;

  @IsString()
  @IsOptional()
  BACKEND_URL?: string;

  @IsString()
  @IsOptional()
  CORS_ORIGIN?: string;

  // Security
  @IsNumber()
  @Min(4)
  @Max(20)
  @IsOptional()
  BCRYPT_ROUNDS: number = 12;

  // File Uploads
  @IsString()
  @IsOptional()
  UPLOAD_DIR?: string;

  // Lesson Access Settings
  @IsNumber()
  @IsOptional()
  LESSON_ACCESS_DAYS?: number;

  @IsNumber()
  @IsOptional()
  LESSON_EXTENSION_DAYS?: number;
}

export function validate(config: Record<string, unknown>) {
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
