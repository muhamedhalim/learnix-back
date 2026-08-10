import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AnalyticsModule } from '../analytics/analytics.module';
import { Lesson } from '../lessons/entities/lesson.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { areQueuesEnabled, QUEUE_CONFIGS, QUEUE_NAMES } from '../queues/queues.constants';
import { registerQueues } from '../queues/register-queues.util';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { AdminExamsController } from './controllers/admin-exams.controller';
import { StudentExamsController } from './controllers/student-exams.controller';
import { StudentQuestionsController } from './controllers/student-questions.controller';
import { TeacherExamsController } from './controllers/teacher-exams.controller';
import { TeacherGradingController } from './controllers/teacher-grading.controller';
import { TeacherOmrController } from './controllers/teacher-omr.controller';
import { TeacherQuestionsController } from './controllers/teacher-questions.controller';
import {
  Exam,
  ExamAttempt,
  ExamAttemptAnswer,
  ExamQuestion,
  ExamSection,
  OmrSheet,
  OmrTemplate,
  Question,
  QuestionVersion,
} from './entities';
import { GradingService } from './grading/grading.service';
import { FiducialMarkerOmrRecognitionProvider } from './omr-recognition/fiducial-marker-recognition.provider';
import { OMR_RECOGNITION_PROVIDER } from './omr-recognition/omr-recognition.interface';
import { ExamAiGradingProcessor } from './processors/exam-ai-grading.processor';
import { ExamAnalyticsProcessor } from './processors/exam-analytics.processor';
import { ExamAutoSubmitProcessor } from './processors/exam-auto-submit.processor';
import { OmrProcessor } from './processors/omr.processor';
import { QuestionTypeRegistry } from './question-types/question-type-registry';
import { AdminExamsService } from './services/admin-exams.service';
import { AttemptGradingService } from './services/attempt-grading.service';
import { AttemptService } from './services/attempt.service';
import { ExamAiGradingService } from './services/exam-ai-grading.service';
import { ExamAccessService } from './services/exam-access.service';
import { ExamAuthoringService } from './services/exam-authoring.service';
import { ExamGradedPublisher } from './services/exam-graded-publisher.service';
import { ExamJobsService } from './services/exam-jobs.service';
import { OmrSheetPdfService } from './services/omr-sheet-pdf.service';
import { OmrSheetsService } from './services/omr-sheets.service';
import { OmrTemplatesService } from './services/omr-templates.service';
import { QuestionBankService } from './services/question-bank.service';
import { TeacherGradingService } from './services/teacher-grading.service';

/**
 * Exams module — normalized exam engine (question bank, authoring, attempt
 * engine, grading) with real BullMQ background jobs (auto-submit, analytics
 * aggregation, AI grading) wired through the shared queue infrastructure.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Question,
      QuestionVersion,
      Exam,
      ExamSection,
      ExamQuestion,
      ExamAttempt,
      ExamAttemptAnswer,
      OmrSheet,
      // `OmrSheet.template` points here. Without the registration
      // `autoLoadEntities` never sees this entity and TypeORM fails to build
      // metadata for the whole DataSource ("Entity metadata for
      // OmrSheet#template was not found"), which prevents the application from
      // booting at all. Unrelated to DEF-005 — repaired here because no E2E
      // suite in this working tree could start otherwise.
      OmrTemplate,
      Subject,
      Lesson,
      LessonPackage,
      // `ExamGradedPublisher` resolves the student's display name.
      User,
      LessonPurchase,
      PackagePurchase,
    ]),
    // Exam background queues (producers + workers share these registrations).
    // Becomes NoopQueue-backed when Redis isn't configured in development.
    registerQueues(
      { name: QUEUE_NAMES.EXAM_AUTO_SUBMIT, config: QUEUE_CONFIGS[QUEUE_NAMES.EXAM_AUTO_SUBMIT] },
      { name: QUEUE_NAMES.EXAM_ANALYTICS, config: QUEUE_CONFIGS[QUEUE_NAMES.EXAM_ANALYTICS] },
      { name: QUEUE_NAMES.EXAM_AI_GRADING, config: QUEUE_CONFIGS[QUEUE_NAMES.EXAM_AI_GRADING] },
      { name: QUEUE_NAMES.EXAM_OMR, config: QUEUE_CONFIGS[QUEUE_NAMES.EXAM_OMR] },
    ),
    AnalyticsModule, // exam analytics recomputation
    NotificationsModule,
  ],
  controllers: [
    TeacherQuestionsController,
    TeacherExamsController,
    TeacherGradingController,
    TeacherOmrController,
    StudentExamsController,
    StudentQuestionsController,
    AdminExamsController,
  ],
  providers: [
    // Domain
    QuestionTypeRegistry,
    GradingService,
    QuestionBankService,
    ExamAccessService,
    ExamAuthoringService,
    AttemptService,
    AttemptGradingService,
    TeacherGradingService,
    ExamAiGradingService,
    AdminExamsService,
    OmrTemplatesService,
    OmrSheetsService,
    OmrSheetPdfService,
    // Behind an interface — the rest of the app depends only on
    // OMR_RECOGNITION_PROVIDER, never on this concrete CV implementation.
    { provide: OMR_RECOGNITION_PROVIDER, useClass: FiducialMarkerOmrRecognitionProvider },
    // Emits ExamGradedEvent post-commit; the notifications module listens.
    ExamGradedPublisher,
    // Jobs (producer + workers)
    ExamJobsService,
    // Workers need a real queue connection to pull jobs from; skip them
    // entirely when queues are disabled rather than let them attempt one.
    ...(areQueuesEnabled()
      ? [ExamAutoSubmitProcessor, ExamAnalyticsProcessor, ExamAiGradingProcessor, OmrProcessor]
      : []),
  ],
  exports: [TypeOrmModule, QuestionTypeRegistry, GradingService],
})
export class ExamsModule {}
