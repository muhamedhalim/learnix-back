import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Book } from '../books/entities/book.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { PaymentsModule } from '../payments/payments.module';
import { LessonPurchase, PackagePurchase, Payment } from '../payments/entities';
import { areQueuesEnabled, QUEUE_CONFIGS, QUEUE_NAMES } from '../queues/queues.constants';
import { registerQueues } from '../queues/register-queues.util';
import { AttendanceCodesService } from './attendance-codes.service';
import { CodeBatchesService } from './code-batches.service';
import { CodeExportService } from './code-export.service';
import {
  AdminAttendanceCodesController,
  AdminCodeBatchesController,
  AdminCodeExportsController,
  AdminCodesController,
  AttendanceCodesController,
} from './controllers';
import { AttendanceCode, AttendanceCodeAudit, CodeBatch, CodeExport } from './entities';
import { CodeExportProcessor } from './processors/code-export.processor';
import { CodeGenerationProcessor } from './processors/code-generation.processor';

@Module({
  imports: [
    PaymentsModule,
    TypeOrmModule.forFeature([
      AttendanceCode,
      CodeBatch,
      AttendanceCodeAudit,
      CodeExport,
      Payment,
      LessonPurchase,
      PackagePurchase,
      Lesson,
      LessonPackage,
      Book,
    ]),
    // Register the generation + export queues here so the producers
    // (services) and workers (processors) share them. Connection comes from
    // the shared queue config — or a NoopQueue when Redis isn't configured
    // in development (see registerQueues).
    registerQueues(
      { name: QUEUE_NAMES.CODE_GENERATION, config: QUEUE_CONFIGS[QUEUE_NAMES.CODE_GENERATION] },
      { name: QUEUE_NAMES.CODE_EXPORT, config: QUEUE_CONFIGS[QUEUE_NAMES.CODE_EXPORT] },
    ),
  ],
  controllers: [
    AdminAttendanceCodesController,
    AttendanceCodesController,
    AdminCodeBatchesController,
    AdminCodesController,
    AdminCodeExportsController,
  ],
  providers: [
    AttendanceCodesService,
    CodeBatchesService,
    CodeExportService,
    // Workers need a real queue connection to pull jobs from; skip them
    // entirely when queues are disabled rather than let them attempt one.
    ...(areQueuesEnabled() ? [CodeGenerationProcessor, CodeExportProcessor] : []),
  ],
  exports: [AttendanceCodesService, CodeBatchesService, CodeExportService],
})
export class AttendanceCodesModule {}
