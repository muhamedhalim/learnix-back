import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AnalyticsModule } from '../analytics/analytics.module';
import { Lesson } from '../lessons/entities/lesson.entity';
import { PaymentsModule } from '../payments/payments.module';
import { QUEUE_CONFIGS, QUEUE_NAMES } from '../queues/queues.constants';
import { Subject } from '../subjects/entities/subject.entity';
import { StudentExamsController } from './controllers/student-exams.controller';
import { TeacherExamsController } from './controllers/teacher-exams.controller';
import { TeacherGradingController } from './controllers/teacher-grading.controller';
import { TeacherQuestionsController } from './controllers/teacher-questions.controller';
import {
  Exam,
  ExamAttempt,
  ExamAttemptAnswer,
  ExamQuestion,
  ExamSection,
  Question,
  QuestionVersion,
} from './entities';
import { GradingService } from './grading/grading.service';
import { ExamAiGradingProcessor } from './processors/exam-ai-grading.processor';
import { ExamAnalyticsProcessor } from './processors/exam-analytics.processor';
import { ExamAutoSubmitProcessor } from './processors/exam-auto-submit.processor';
import { QuestionTypeRegistry } from './question-types/question-type-registry';
import { AttemptGradingService } from './services/attempt-grading.service';
import { AttemptService } from './services/attempt.service';
import { ExamAiGradingService } from './services/exam-ai-grading.service';
import { ExamAuthoringService } from './services/exam-authoring.service';
import { ExamJobsService } from './services/exam-jobs.service';
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
      Subject,
      Lesson,
    ]),
    // Exam background queues (producers + workers share these registrations).
    BullModule.registerQueue(
      { name: QUEUE_NAMES.EXAM_AUTO_SUBMIT, ...QUEUE_CONFIGS[QUEUE_NAMES.EXAM_AUTO_SUBMIT] },
      { name: QUEUE_NAMES.EXAM_ANALYTICS, ...QUEUE_CONFIGS[QUEUE_NAMES.EXAM_ANALYTICS] },
      { name: QUEUE_NAMES.EXAM_AI_GRADING, ...QUEUE_CONFIGS[QUEUE_NAMES.EXAM_AI_GRADING] },
    ),
    PaymentsModule, // enrollment/access checks (hasLessonPlaybackAccess)
    AnalyticsModule, // exam analytics recomputation
  ],
  controllers: [
    TeacherQuestionsController,
    TeacherExamsController,
    TeacherGradingController,
    StudentExamsController,
  ],
  providers: [
    // Domain
    QuestionTypeRegistry,
    GradingService,
    QuestionBankService,
    ExamAuthoringService,
    AttemptService,
    AttemptGradingService,
    TeacherGradingService,
    ExamAiGradingService,
    // Jobs (producer + workers)
    ExamJobsService,
    ExamAutoSubmitProcessor,
    ExamAnalyticsProcessor,
    ExamAiGradingProcessor,
  ],
  exports: [TypeOrmModule, QuestionTypeRegistry, GradingService],
})
export class ExamsModule {}
