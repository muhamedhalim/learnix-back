import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPurchase, PackagePurchase, Payment } from '../payments/entities';
import { QUEUE_CONFIGS, QUEUE_NAMES } from '../queues/queues.constants';
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
    ]),
    // Register the generation + export queues here so the producers
    // (services) and workers (processors) share them. Connection comes from
    // the shared queue config.
    BullModule.registerQueue(
      {
        name: QUEUE_NAMES.CODE_GENERATION,
        ...QUEUE_CONFIGS[QUEUE_NAMES.CODE_GENERATION],
      },
      {
        name: QUEUE_NAMES.CODE_EXPORT,
        ...QUEUE_CONFIGS[QUEUE_NAMES.CODE_EXPORT],
      },
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
    CodeGenerationProcessor,
    CodeExportProcessor,
  ],
  exports: [AttendanceCodesService, CodeBatchesService, CodeExportService],
})
export class AttendanceCodesModule {}
