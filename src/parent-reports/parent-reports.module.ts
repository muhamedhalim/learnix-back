import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { LessonSession } from '../attendance/entities/lesson-session.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { GuardiansModule } from '../guardians/guardians.module';
import { HomeworkSubmission } from '../lessons/entities/homework-submission.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { areQueuesEnabled, QUEUE_CONFIGS, QUEUE_NAMES } from '../queues/queues.constants';
import { registerQueues } from '../queues/register-queues.util';
import { User } from '../users/entities/user.entity';
import { ParentReport } from './entities/parent-report.entity';
import { ParentReportProcessor } from './processors/parent-report.processor';
import { ParentReportAggregatorService } from './services/parent-report-aggregator.service';
import { ParentReportService } from './services/parent-report.service';
import { ParentReportJobsService } from './services/parent-report-jobs.service';

/**
 * The periodic guardian report engine.
 *
 * A module of its own rather than a corner of `NotificationsModule`, for one
 * structural reason: aggregation has to read lessons, attendance, exams and
 * homework, and `NotificationsModule` must not acquire dependencies on four
 * content domains to send a message. The dependency runs one way only —
 * reports → notifications — and the seam between them is a single call to
 * `ParentNotificationJobsService.enqueueDelivery`.
 *
 *   parent_reports  →  ParentNotification  →  ChannelRegistry  →  WhatsApp / SMS
 *   (this module)      (DEF-005 pipeline)     (DEF-005)           (DEF-005)
 *
 * Entities are registered read-only here (`TypeOrmModule.forFeature` grants a
 * repository, not ownership); every one of them is written by its own domain.
 * The engine only counts what those domains already decided.
 */
@Module({
  imports: [
    GuardiansModule,
    NotificationsModule,
    // NoopQueue-backed when Redis isn't configured in development, exactly as
    // for the notification queues — the sweeps simply never fire there.
    registerQueues({
      name: QUEUE_NAMES.PARENT_REPORTS,
      config: QUEUE_CONFIGS[QUEUE_NAMES.PARENT_REPORTS],
    }),
    TypeOrmModule.forFeature([
      ParentReport,
      // Read-only aggregation sources.
      AttendanceRecord,
      ExamAttempt,
      HomeworkSubmission,
      LessonProgress,
      LessonSession,
      User,
    ]),
  ],
  providers: [
    ParentReportAggregatorService,
    ParentReportService,
    ParentReportJobsService,
    // The worker needs a real queue connection to pull from; skip it entirely
    // when queues are disabled rather than let it attempt one.
    ...(areQueuesEnabled() ? [ParentReportProcessor] : []),
  ],
  exports: [ParentReportAggregatorService, ParentReportService],
})
export class ParentReportsModule {}
