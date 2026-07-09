// CRITICAL: Import polyfills FIRST to ensure crypto is globally available before TypeORM initializes
import './polyfills';

import { CacheModule } from '@nestjs/cache-manager';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { redisStore } from 'cache-manager-redis-yet';

import { ActivityLogsModule } from './activity-logs/activity-logs.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AttendanceModule } from './attendance/attendance.module';
import { AttendanceCodesModule } from './attendance-codes/attendance-codes.module';
// Core modules (keeping these)
import { AuthModule } from './auth/auth.module';
// Phase 5: Books & Attendance & Analytics & Cart
import { BooksModule } from './books/books.module';
import { BulkOperationsModule } from './bulk-operations/bulk-operations.module';
import { CallCenterModule } from './callcenter/callcenter.module';
import { CartModule } from './cart/cart.module';
import { CommentsModule } from './comments/comments.module';
import { THROTTLE } from './common/constants';
import { SanitizationModule } from './common/sanitization/sanitization.module';
import { ComplaintsModule } from './complaints/complaints.module';
import { validate } from './config/env.validation';
import { DiscountCodesModule } from './discount-codes/discount-codes.module';
// Phase 3: Exams & Grading
import { ExamsModule } from './exams/exams.module';
import { FirebaseModule } from './firebase/firebase.module';
import { GamificationModule } from './gamification/gamification.module';
import { HealthModule } from './health/health.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { LessonsModule } from './lessons/lessons.module';
import { MailModule } from './mail/mail.module';
import { MediaModule } from './media/media.module';
import { StorageModule } from './storage/storage.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ObservabilityModule } from './observability/observability.module';
import { QueryPerformanceSubscriber } from './observability/query-performance.subscriber';
// Phase 2: Core Features
import { PackagesModule } from './packages/packages.module';
// Phase 4: Payments & Notifications
import { PaymentsModule } from './payments/payments.module';
import { ReportsModule } from './reports/reports.module';
import { ReviewsModule } from './reviews/reviews.module';
import { StudentsModule } from './students/students.module';
// Phase 1 Foundation: Core educational platform modules
import { SubjectsModule } from './subjects/subjects.module';
import { TeachersModule } from './teachers/teachers.module';
import { UploadModule } from './uploads/upload.module';
import { QueuesModule } from './queues/queues.module';
import { User } from './users/entities/user.entity';
import { UsersModule } from './users/users.module';

/**
 * Build a `redis://` connection URL from the configured Redis settings, or
 * `undefined` when Redis is not configured (local development). Shared by the
 * cache store and the rate-limiter storage so both target the same instance.
 */
function buildRedisUrl(configService: ConfigService): string | undefined {
  const explicitUrl = configService.get<string>('REDIS_URL');
  if (explicitUrl !== undefined && explicitUrl !== '') {
    return explicitUrl;
  }

  const host = configService.get<string>('REDIS_HOST');
  if (host === undefined || host === '') {
    return undefined;
  }

  const port = configService.get<number>('REDIS_PORT') ?? 6379;
  const password = configService.get<string>('REDIS_PASSWORD');

  return password !== undefined && password !== ''
    ? `redis://:${password}@${host}:${port.toString()}`
    : `redis://${host}:${port.toString()}`;
}

@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const redisUrl = buildRedisUrl(configService);
        const isProduction = configService.get<string>('NODE_ENV') === 'production';
        const logger = new Logger('CacheModule');

        // Production MUST use Redis — a per-instance in-memory cache is unsafe
        // for a horizontally-scaled deployment (stale reads, no shared
        // invalidation). Fail fast instead of silently degrading.
        if (redisUrl === undefined) {
          if (isProduction) {
            throw new Error(
              'CRITICAL: REDIS_HOST is required in production. Refusing to start with an in-memory cache.',
            );
          }
          logger.warn(
            'REDIS_HOST not set - using in-memory cache (development only, not for production)',
          );
          return {
            ttl: 5 * 60 * 1000, // 5 minutes in milliseconds
          };
        }

        try {
          const store = await redisStore({
            url: redisUrl,
            socket: {
              connectTimeout: 10_000,
            },
          });

          return {
            store,
            ttl: 5 * 60 * 1000, // 5 minutes default TTL
          };
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          // In production a failed Redis connection is fatal — do not silently
          // fall back to an in-memory cache.
          if (isProduction) {
            throw new Error(
              `CRITICAL: Failed to connect to Redis in production: ${errorMessage}`,
            );
          }

          logger.warn(
            `Failed to connect to Redis: ${errorMessage}. Using in-memory cache (development only).`,
          );
          return {
            ttl: 5 * 60 * 1000,
          };
        }
      },
    }),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate,
    }),
    EventEmitterModule.forRoot(),
    ObservabilityModule,
    SanitizationModule,
    ScheduleModule.forRoot(),
    AuthModule,
    // Single global backstop tier. Do NOT add stricter named tiers here — the
    // global ThrottlerGuard enforces EVERY named config on EVERY route, so a
    // strict entry would rate-limit the whole API. Sensitive routes tighten
    // limits per-route via @Throttle({ default: THROTTLE.<TIER> }).
    // Rate limiting. Uses Redis-backed storage in every environment where Redis
    // is configured so limits are shared across horizontally-scaled instances
    // (an in-memory store would only count requests per-replica, weakening
    // brute-force protection). Falls back to the default in-memory store only
    // when Redis is not configured (local development).
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const throttlers = [{ name: 'default', ...THROTTLE.GLOBAL }];
        const redisUrl = buildRedisUrl(configService);

        if (redisUrl === undefined) {
          return { throttlers };
        }

        return {
          throttlers,
          storage: new ThrottlerStorageRedisService(redisUrl),
        };
      },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const databaseUrl = configService.get<string>('DATABASE_URL');
        const isProduction = configService.get<string>('NODE_ENV') === 'production';
        const synchronize = configService.get<string>('TYPEORM_SYNCHRONIZE') === 'true';
        const typeOrmLogging = configService.get<string>('TYPEORM_LOGGING');

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

        // Connection-pool sizing. Defaults are conservative and overridable via
        // env so the pool can be tuned to the database plan without a redeploy.
        const poolMax = Number(configService.get<string>('DB_POOL_MAX')) || 10;
        const poolMin = Number(configService.get<string>('DB_POOL_MIN')) || 2;
        const idleTimeoutMs =
          Number(configService.get<string>('DB_POOL_IDLE_TIMEOUT_MS')) || 30_000;
        const connectionTimeoutMs =
          Number(configService.get<string>('DB_POOL_CONNECTION_TIMEOUT_MS')) || 10_000;

        return {
          type: 'postgres',
          url: databaseUrl ?? '',
          autoLoadEntities: true,
          subscribers: [QueryPerformanceSubscriber],
          synchronize: shouldSynchronize,
          logging: typeOrmLogging === 'true' || (!isProduction && typeOrmLogging !== 'false'),
          // node-postgres pool tuning (passed through by TypeORM).
          poolSize: poolMax,
          extra: {
            max: poolMax,
            min: poolMin,
            idleTimeoutMillis: idleTimeoutMs,
            connectionTimeoutMillis: connectionTimeoutMs,
          },
          ssl:
            databaseUrl !== undefined && databaseUrl !== '' && isProduction
              ? {
                  rejectUnauthorized: process.env['SSL_REJECT_UNAUTHORIZED'] !== 'false',
                }
              : false,
        };
      },
    }), // Global XSS protection
    QueuesModule, // BullMQ job queues (Redis-backed)
    TypeOrmModule.forFeature([User]),
    UsersModule,
    FirebaseModule,
    MailModule,
    StorageModule,
    UploadModule,
    MediaModule,
    HealthModule,

    // Phase 1 Foundation: Core educational platform modules
    SubjectsModule,
    StudentsModule,
    TeachersModule,
    LessonsModule,

    // Phase 2: Core Features
    PackagesModule,
    CommentsModule,
    ReviewsModule,
    ComplaintsModule,
    CallCenterModule,

    // Phase 3: Exams & Grading
    ExamsModule,
    GamificationModule,

    // Phase 4: Payments & Notifications
    IdempotencyModule,
    PaymentsModule,
    DiscountCodesModule,
    AttendanceCodesModule,
    NotificationsModule,

    // Phase 5: Books & Attendance & Analytics & Cart
    BooksModule,
    AttendanceModule,
    AnalyticsModule,
    ReportsModule,
    CartModule,

    // Phase 3 Enhancements: Activity Logging & Bulk Operations
    ActivityLogsModule,
    BulkOperationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Enforce the ThrottlerModule limits globally — without this guard the
    // rate-limit configuration above is inert.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
