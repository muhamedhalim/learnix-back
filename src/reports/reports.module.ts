import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { CsvExporterService, PdfExporterService } from './exporters';
import { Report } from './entities';
import { Payment } from '../payments/entities/payment.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { Lesson } from '../lessons/entities/lesson.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Report, Payment, ExamAttempt, Lesson])],
  controllers: [ReportsController],
  providers: [ReportsService, CsvExporterService, PdfExporterService],
  exports: [ReportsService],
})
export class ReportsModule {}
