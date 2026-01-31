// CRITICAL: Import polyfills FIRST to ensure crypto is globally available before TypeORM initializes
import './polyfills';

import { CacheModule } from '@nestjs/cache-manager';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { HealthModule } from './health/health.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { LessonsModule } from './lessons/lessons.module';
import { NotificationsModule } from './notifications/notifications.module';
// Phase 2: Core Features
import { PackagesModule } from './packages/packages.module';
// Phase 4: Payments & Notifications
import { PaymentsModule } from './payments/payments.module';
import { ReviewsModule } from './reviews/reviews.module';
import { StudentsModule } from './students/students.module';
// Phase 1 Foundation: Core educational platform modules
import { SubjectsModule } from './subjects/subjects.module';
import { TeachersModule } from './teachers/teachers.module';
import { UploadModule } from './uploads/upload.module';
// TEMPORARILY DISABLED: Redis not available for development
// import { QueuesModule } from './queues/queues.module';
import { User } from './users/entities/user.entity';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate,
    }),
    EventEmitterModule.forRoot(),
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
        if (redisHost === undefined || redisHost === '') {
          logger.warn(
            'WARNING: REDIS_HOST not set - Using in-memory cache (not recommended for production)',
          );
          return {
            ttl: 5 * 60 * 1000, // 5 minutes in milliseconds
          };
        }

        const port = redisPort ?? 6379;
        const redisUrl =
          redisPassword !== undefined && redisPassword !== ''
            ? `redis://:${redisPassword}@${redisHost}:${port.toString()}`
            : `redis://${redisHost}:${port.toString()}`;

        logger.log(`Connecting to Redis at ${redisHost}:${port.toString()}`);

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
          url: databaseUrl ?? '',
          autoLoadEntities: true,
          synchronize: shouldSynchronize,
          logging: !isProduction,
          ssl:
            databaseUrl !== undefined && databaseUrl !== '' && isProduction
              ? {
                  rejectUnauthorized:
                    process.env['SSL_REJECT_UNAUTHORIZED'] !== 'false',
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
    CommentsModule,
    ReviewsModule,
    ComplaintsModule,
    CallCenterModule,

    // Phase 3: Exams & Grading
    ExamsModule,

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
    CartModule,

    // Phase 3 Enhancements: Activity Logging & Bulk Operations
    ActivityLogsModule,
    BulkOperationsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
