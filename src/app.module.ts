import { Module, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule } from '@nestjs/cache-manager';
import { redisStore } from 'cache-manager-redis-yet';
import { validate } from './config/env.validation';
import { THROTTLE } from './common/constants';
import { AppController } from './app.controller';
import { AppService } from './app.service';

// Core modules (keeping these)
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { FirebaseModule } from './firebase/firebase.module';
import { UploadModule } from './uploads/upload.module';
import { HealthModule } from './health/health.module';
import { SanitizationModule } from './common/sanitization/sanitization.module';
// TEMPORARILY DISABLED: Redis not available for development
// import { QueuesModule } from './queues/queues.module';
import { User } from './users/entities/user.entity';

// Phase 1 Foundation: Core educational platform modules
import { SubjectsModule } from './subjects/subjects.module';
import { TeachersModule } from './teachers/teachers.module';
import { StudentsModule } from './students/students.module';
import { LessonsModule } from './lessons/lessons.module';

// Phase 2: Core Features
import { PackagesModule } from './packages/packages.module';

// Phase 3: Exams & Grading
import { ExamsModule } from './exams/exams.module';

// Phase 4: Payments & Notifications
import { PaymentsModule } from './payments/payments.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { DiscountCodesModule } from './discount-codes/discount-codes.module';
import { PurchaseCodesModule } from './purchase-codes/purchase-codes.module';
import { NotificationsModule } from './notifications/notifications.module';

// Phase 5: Books & Attendance
import { BooksModule } from './books/books.module';
import { AttendanceModule } from './attendance/attendance.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate,
    }),
    ScheduleModule.forRoot(),
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const redisHost = configService.get<string>('REDIS_HOST');
        const redisPort = configService.get<number>('REDIS_PORT');
        const redisPassword = configService.get<string>('REDIS_PASSWORD');
        const logger = new Logger('CacheModule');

        // If no Redis host, use in-memory cache (development fallback)
        if (!redisHost) {
          logger.warn(
            'WARNING: REDIS_HOST not set - Using in-memory cache (not recommended for production)',
          );
          return {
            ttl: 5 * 60 * 1000, // 5 minutes in milliseconds
          };
        }

        const redisUrl = redisPassword
          ? `redis://:${redisPassword}@${redisHost}:${redisPort}`
          : `redis://${redisHost}:${redisPort}`;

        logger.log(`Connecting to Redis at ${redisHost}:${redisPort}`);

        try {
          const store = await redisStore({
            url: redisUrl,
            socket: {
              connectTimeout: 10000,
            },
          });

          return {
            store,
            ttl: 5 * 60 * 1000, // 5 minutes default TTL
          };
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          logger.warn(
            `WARNING: Failed to connect to Redis: ${errorMessage}. Using in-memory cache.`,
          );
          return {
            ttl: 5 * 60 * 1000,
          };
        }
      },
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ...THROTTLE.DEFAULT,
      },
      {
        name: 'strict',
        ...THROTTLE.STRICT,
      },
    ]),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const databaseUrl = configService.get<string>('DATABASE_URL');
        const isProduction =
          configService.get<string>('NODE_ENV') === 'production';
        const synchronize =
          configService.get<string>('TYPEORM_SYNCHRONIZE') === 'true';

        if (isProduction && synchronize) {
          throw new Error(
            'CRITICAL: Cannot enable TypeORM synchronize in production! This could cause catastrophic data loss.',
          );
        }

        const shouldSynchronize = !isProduction && synchronize;
        const logger = new Logger('TypeORM');

        if (shouldSynchronize) {
          logger.warn(
            'WARNING: TypeORM synchronize is ENABLED. This should only be used in development.',
          );
        }

        return {
          type: 'postgres',
          url: databaseUrl,
          autoLoadEntities: true,
          synchronize: shouldSynchronize,
          logging: !isProduction,
          ssl:
            databaseUrl && isProduction
              ? {
                  rejectUnauthorized:
                    process.env.SSL_REJECT_UNAUTHORIZED !== 'false',
                }
              : false,
        };
      },
    }),
    TypeOrmModule.forFeature([User]), // For AppService admin init
    SanitizationModule, // Global XSS protection
    // TEMPORARILY DISABLED: Redis not available for development
    // QueuesModule, // BullMQ job queues
    AuthModule,
    UsersModule,
    FirebaseModule,
    UploadModule,
    HealthModule,

    // Phase 1 Foundation: Core educational platform modules
    SubjectsModule,
    StudentsModule,
    TeachersModule,
    LessonsModule,

    // Phase 2: Core Features
    PackagesModule,

    // Phase 3: Exams & Grading
    ExamsModule,

    // Phase 4: Payments & Notifications
    IdempotencyModule,
    PaymentsModule,
    DiscountCodesModule,
    PurchaseCodesModule,
    NotificationsModule,

    // Phase 5: Books & Attendance
    BooksModule,
    AttendanceModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
