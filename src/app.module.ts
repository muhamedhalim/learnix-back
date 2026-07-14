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
import Redis from 'ioredis';

import { ActivityLogsModule } from './activity-logs/activity-logs.module';
import { AdminInitModule } from './admin-init/admin-init.module';
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
import { CertificatesModule } from './certificates/certificates.module';
import { CommentsModule } from './comments/comments.module';
import { THROTTLE } from './common/constants';
import { SanitizationModule } from './common/sanitization/sanitization.module';
import { resolveDatabaseSsl } from './common/utils/database-ssl.util';
import { resolveRedisUrl } from './common/utils/redis-connection.util';
import { ComplaintsModule } from './complaints/complaints.module';
import { validate } from './config/env.validation';
import { DiscountCodesModule } from './discount-codes/discount-codes.module';
// Phase 3: Exams & Grading
import { ExamsModule } from './exams/exams.module';
import { FirebaseModule } from './firebase/firebase.module';
import { GamificationModule } from './gamification/gamification.module';
import { HealthModule } from './health/health.module';
import { GuardiansModule } from './guardians/guardians.module';
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
import { SearchModule } from './search/search.module';
import { StudentsModule } from './students/students.module';
// Phase 1 Foundation: Core educational platform modules
import { SubjectsModule } from './subjects/subjects.module';
import { TeachersModule } from './teachers/teachers.module';
import { TeacherFollowUpModule } from './teacher-follow-up/teacher-follow-up.module';
import { UploadModule } from './uploads/upload.module';
import { WishlistModule } from './wishlist/wishlist.module';
import { QueuesModule } from './queues/queues.module';
import { User } from './users/entities/user.entity';
import { UsersModule } from './users/users.module';

/**
 * Build a `redis://` connection URL from the configured Redis settings, or
 * `undefined` when Redis is not configured (local development). Shared by the
 * cache store and the rate-limiter storage so both target the same instance.
 * Thin `ConfigService`-backed wrapper around `resolveRedisUrl`, the same
 * resolution logic BullMQ's queue registration uses (see `queues.constants.ts`).
 */
function buildRedisUrl(configService: ConfigService): string | undefined {
  return resolveRedisUrl((key) => configService.get<string>(key));
}

@Module({
  imports: [
    AdminInitModule,
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
              // Development: node-redis's default reconnectStrategy retries
              // forever, which would otherwise keep hammering an unreachable
              // host (e.g. REDIS_URL still pointing at a production-only
              // network) with background reconnect noise even after this
              // catch block already fell back to the in-memory cache.
              // Production keeps the default strategy unchanged.
              ...(isProduction ? {} : { reconnectStrategy: false as const }),
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
            throw new Error(`CRITICAL: Failed to connect to Redis in production: ${errorMessage}`);
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
      useFactory: async (configService: ConfigService) => {
        const throttlers = [{ name: 'default', ...THROTTLE.GLOBAL }];
        const redisUrl = buildRedisUrl(configService);

        if (redisUrl === undefined) {
          return { throttlers };
        }

        const isProduction = configService.get<string>('NODE_ENV') === 'production';

        if (isProduction) {
          // Unchanged: production always wires up Redis-backed storage
          // directly. A connection failure here is a production incident,
          // not something to silently degrade from.
          return { throttlers, storage: new ThrottlerStorageRedisService(redisUrl) };
        }

        // Development: verify Redis is actually reachable before wiring it
        // up — ThrottlerStorageRedisService's underlying ioredis client
        // retries forever by default, which is what turned an unreachable
        // REDIS_URL into unbounded "[ioredis] Unhandled error event" log
        // spam. Same failure class already solved for the cache store above.
        const logger = new Logger('ThrottlerModule');
        const client = new Redis(redisUrl, {
          lazyConnect: true,
          connectTimeout: 5000,
          retryStrategy: () => null,
          maxRetriesPerRequest: 1,
        });

        try {
          await client.connect();
          return { throttlers, storage: new ThrottlerStorageRedisService(client) };
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.warn(
            `Failed to connect to Redis: ${errorMessage}. Using in-memory rate-limit storage (development only).`,
          );
          client.disconnect();
          return { throttlers };
        }
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
          ssl: resolveDatabaseSsl(databaseUrl),
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
    GuardiansModule,
    NotificationsModule,
    TeacherFollowUpModule,

    // Phase 5: Books & Attendance & Analytics & Cart
    BooksModule,
    AttendanceModule,
    AnalyticsModule,
    ReportsModule,
    CartModule,
    WishlistModule,
    CertificatesModule,
    SearchModule,

    // Phase 3 Enhancements: Activity Logging & Bulk Operations
    ActivityLogsModule,
    BulkOperationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Enforce the ThrottlerModule limits globally — without this guard the
    // rate-limit configuration above is inert.
    ...(process.env['NODE_ENV'] === 'test'
      ? []
      : [{ provide: APP_GUARD, useClass: ThrottlerGuard }]),
  ],
})
export class AppModule {}
