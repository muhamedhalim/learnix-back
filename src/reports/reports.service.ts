/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import {
  Report,
  ReportFilters,
  ReportType,
  ReportStatus,
  FileFormat,
} from './entities';
import { CsvExporterService } from './exporters/csv-exporter.service';
import { PdfExporterService } from './exporters/pdf-exporter.service';
import { Payment } from '../payments/entities/payment.entity';
import { PaymentStatus } from '../payments/entities/payment-status.enum';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { ExamStatus } from '../exams/entities/exam-status.enum';
import { Lesson } from '../lessons/entities/lesson.entity';

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  private readonly maxRows = parseInt(
    process.env.REPORTS_MAX_ROWS || '10000',
    10,
  );

  constructor(
    @InjectRepository(Report)
    private readonly reportRepository: Repository<Report>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(ExamAttempt)
    private readonly examAttemptRepository: Repository<ExamAttempt>,
    @InjectRepository(Lesson)
    private readonly lessonRepository: Repository<Lesson>,
    private readonly csvExporter: CsvExporterService,
    private readonly pdfExporter: PdfExporterService,
  ) {}

  /**
   * Create a new report request (returns immediately, processes in background)
   */
  async createReport(
    type: ReportType,
    format: FileFormat,
    filters: ReportFilters,
    generatedBy: number,
  ): Promise<Report> {
    const report = this.reportRepository.create({
      type,
      file_format: format,
      filters,
      generated_by: generatedBy,
      status: ReportStatus.PENDING,
    });

    await this.reportRepository.save(report);
    this.logger.log(`Report created: ${report.id} (${type})`);

    return report;
  }

  /**
   * Process a pending report (called by background job)
   */
  async processReport(reportId: number): Promise<void> {
    const report = await this.reportRepository.findOne({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException(`Report ${reportId} not found`);
    }

    try {
      // Update status to processing
      report.status = ReportStatus.PROCESSING;
      await this.reportRepository.save(report);

      // Generate report based on type
      let result: { filePath: string; rowCount: number; fileSize: number };

      switch (report.type) {
        case ReportType.STUDENT_PERFORMANCE:
          result = await this.generateStudentReport(report);
          break;
        case ReportType.TEACHER_ENGAGEMENT:
          result = await this.generateTeacherReport(report);
          break;
        case ReportType.FINANCIAL:
          result = await this.generateFinancialReport(report);
          break;
        case ReportType.EXAM_ANALYTICS:
          result = await this.generateExamReport(report);
          break;
        case ReportType.CONTENT_PERFORMANCE:
          result = await this.generateContentReport(report);
          break;
        default:
          throw new Error(`Unknown report type: ${report.type}`);
      }

      // Update report with results
      report.status = ReportStatus.COMPLETED;
      report.file_path = result.filePath;
      report.row_count = result.rowCount;
      report.file_size = result.fileSize;
      report.completed_at = new Date();
      await this.reportRepository.save(report);

      this.logger.log(`Report completed: ${reportId}`);
    } catch (error) {
      report.status = ReportStatus.FAILED;
      report.error_message = (error as Error).message;
      await this.reportRepository.save(report);

      this.logger.error(
        `Report failed: ${reportId} - ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Generate Student Performance Report
   */
  private async generateStudentReport(
    report: Report,
  ): Promise<{ filePath: string; rowCount: number; fileSize: number }> {
    const filters = report.filters || {};
    const dateRange = this.getDateRange(filters);

    // Query exam attempts for students
    const query = this.examAttemptRepository
      .createQueryBuilder('attempt')
      .innerJoin('attempt.student', 'student')
      .innerJoin('attempt.exam', 'exam')
      .leftJoin('exam.lesson', 'lesson')
      .leftJoin('lesson.subject', 'subject')
      .select([
        'student.id as student_id',
        "CONCAT(student.first_name, ' ', student.last_name) as student_name",
        'student.email as student_email',
        'exam.title as exam_title',
        'subject.title as subject_name',
        'attempt.total_score as score',
        'exam.total_marks as max_score',
        'attempt.status as status',
        'attempt.submitted_at as submitted_at',
      ])
      .where('attempt.created_at BETWEEN :startDate AND :endDate', dateRange)
      .andWhere(`attempt.status = '${ExamStatus.GRADED}'`);

    if (filters.studentIds?.length) {
      query.andWhere('student.id IN (:...studentIds)', {
        studentIds: filters.studentIds,
      });
    }

    if (filters.subjectId) {
      query.andWhere('subject.id = :subjectId', {
        subjectId: filters.subjectId,
      });
    }

    const data = await query.limit(this.maxRows).getRawMany();

    // Calculate percentages
    const processedData = data.map((row) => ({
      ...row,
      percentage:
        row.max_score > 0
          ? ((row.score / row.max_score) * 100).toFixed(2) + '%'
          : 'N/A',
    }));

    return this.exportData(report, processedData, {
      filename: 'student_performance_report',
      title: 'Student Performance Report',
      subtitle: `${dateRange.startDate.toLocaleDateString()} - ${dateRange.endDate.toLocaleDateString()}`,
      fields: [
        'student_name',
        'student_email',
        'exam_title',
        'subject_name',
        'score',
        'max_score',
        'percentage',
        'submitted_at',
      ],
      columns: [
        { key: 'student_name', header: 'Student Name', width: 120 },
        { key: 'student_email', header: 'Email', width: 140 },
        { key: 'exam_title', header: 'Exam', width: 100 },
        { key: 'subject_name', header: 'Subject', width: 80 },
        { key: 'score', header: 'Score', width: 50 },
        { key: 'max_score', header: 'Max', width: 40 },
        { key: 'percentage', header: '%', width: 50 },
      ],
    });
  }

  /**
   * Generate Teacher Engagement Report
   */
  private async generateTeacherReport(
    report: Report,
  ): Promise<{ filePath: string; rowCount: number; fileSize: number }> {
    const filters = report.filters || {};
    const dateRange = this.getDateRange(filters);

    const query = this.lessonRepository
      .createQueryBuilder('lesson')
      .innerJoin('lesson.teacher', 'teacher')
      .innerJoin('lesson.subject', 'subject')
      .leftJoin('lesson.purchases', 'purchase')
      .select([
        'teacher.id as teacher_id',
        "CONCAT(teacher.first_name, ' ', teacher.last_name) as teacher_name",
        'teacher.email as teacher_email',
        'subject.title as subject_name',
        'COUNT(DISTINCT lesson.id) as lessons_count',
        'COALESCE(SUM(lesson.students_count), 0) as total_students',
        'COALESCE(SUM(purchase.price_paid), 0) as total_revenue',
      ])
      .where('lesson.deleted_at IS NULL')
      .andWhere('lesson.created_at BETWEEN :startDate AND :endDate', dateRange)
      .groupBy(
        'teacher.id, teacher.first_name, teacher.last_name, teacher.email, subject.title',
      );

    if (filters.teacherIds?.length) {
      query.andWhere('teacher.id IN (:...teacherIds)', {
        teacherIds: filters.teacherIds,
      });
    }

    if (filters.subjectId) {
      query.andWhere('subject.id = :subjectId', {
        subjectId: filters.subjectId,
      });
    }

    const data = await query.limit(this.maxRows).getRawMany();

    return this.exportData(report, data, {
      filename: 'teacher_engagement_report',
      title: 'Teacher Engagement Report',
      subtitle: `${dateRange.startDate.toLocaleDateString()} - ${dateRange.endDate.toLocaleDateString()}`,
      fields: [
        'teacher_name',
        'teacher_email',
        'subject_name',
        'lessons_count',
        'total_students',
        'total_revenue',
      ],
      columns: [
        { key: 'teacher_name', header: 'Teacher Name', width: 120 },
        { key: 'teacher_email', header: 'Email', width: 140 },
        { key: 'subject_name', header: 'Subject', width: 100 },
        { key: 'lessons_count', header: 'Lessons', width: 60 },
        { key: 'total_students', header: 'Students', width: 60 },
        { key: 'total_revenue', header: 'Revenue (EGP)', width: 80 },
      ],
    });
  }

  /**
   * Generate Financial Report
   */
  private async generateFinancialReport(
    report: Report,
  ): Promise<{ filePath: string; rowCount: number; fileSize: number }> {
    const filters = report.filters || {};
    const dateRange = this.getDateRange(filters);

    const query = this.paymentRepository
      .createQueryBuilder('payment')
      .innerJoin('payment.user', 'user')
      .select([
        'payment.id as payment_id',
        'payment.created_at as date',
        "CONCAT(user.first_name, ' ', user.last_name) as customer_name",
        'user.email as customer_email',
        'payment.item_type as item_type',
        'payment.amount as amount',
        'payment.discount_amount as discount',
        'payment.final_amount as final_amount',
        'payment.payment_method as payment_method',
        'payment.status as status',
      ])
      .where('payment.created_at BETWEEN :startDate AND :endDate', dateRange)
      .andWhere(`payment.status = '${PaymentStatus.COMPLETED}'`);

    if (filters.paymentMethod) {
      query.andWhere('payment.payment_method = :paymentMethod', {
        paymentMethod: filters.paymentMethod,
      });
    }

    const data = await query
      .orderBy('payment.created_at', 'DESC')
      .limit(this.maxRows)
      .getRawMany();

    // Calculate summary
    const summary = {
      totalTransactions: data.length,
      totalRevenue: data.reduce(
        (sum, row) => sum + parseFloat(row.final_amount || 0),
        0,
      ),
      totalDiscounts: data.reduce(
        (sum, row) => sum + parseFloat(row.discount || 0),
        0,
      ),
    };

    return this.exportData(report, data, {
      filename: 'financial_report',
      title: 'Financial Report',
      subtitle: `${dateRange.startDate.toLocaleDateString()} - ${dateRange.endDate.toLocaleDateString()}`,
      fields: [
        'date',
        'customer_name',
        'customer_email',
        'item_type',
        'amount',
        'discount',
        'final_amount',
        'payment_method',
      ],
      columns: [
        { key: 'date', header: 'Date', width: 80 },
        { key: 'customer_name', header: 'Customer', width: 100 },
        { key: 'item_type', header: 'Type', width: 60 },
        { key: 'amount', header: 'Amount', width: 60 },
        { key: 'discount', header: 'Discount', width: 60 },
        { key: 'final_amount', header: 'Final', width: 60 },
        { key: 'payment_method', header: 'Method', width: 60 },
      ],
      summary,
    });
  }

  /**
   * Generate Exam Analytics Report
   */
  private async generateExamReport(
    report: Report,
  ): Promise<{ filePath: string; rowCount: number; fileSize: number }> {
    const filters = report.filters || {};
    const dateRange = this.getDateRange(filters);

    const query = this.examAttemptRepository
      .createQueryBuilder('attempt')
      .innerJoin('attempt.exam', 'exam')
      .leftJoin('exam.teacher', 'teacher')
      .select([
        'exam.id as exam_id',
        'exam.title as exam_title',
        "CONCAT(teacher.first_name, ' ', teacher.last_name) as teacher_name",
        'COUNT(*) as total_attempts',
        'COALESCE(AVG(attempt.total_score), 0) as avg_score',
        'COALESCE(MIN(attempt.total_score), 0) as min_score',
        'COALESCE(MAX(attempt.total_score), 0) as max_score',
        'exam.passing_marks as passing_marks',
        'exam.total_marks as total_marks',
      ])
      .where('attempt.created_at BETWEEN :startDate AND :endDate', dateRange)
      .andWhere(`attempt.status = '${ExamStatus.GRADED}'`)
      .groupBy(
        'exam.id, exam.title, teacher.first_name, teacher.last_name, exam.passing_marks, exam.total_marks',
      );

    if (filters.examIds?.length) {
      query.andWhere('exam.id IN (:...examIds)', {
        examIds: filters.examIds,
      });
    }

    const data = await query.limit(this.maxRows).getRawMany();

    // Calculate pass rate for each exam
    const processedData = await Promise.all(
      data.map(async (row) => {
        const passCount = await this.examAttemptRepository
          .createQueryBuilder('attempt')
          .where('attempt.exam_id = :examId', { examId: row.exam_id })
          .andWhere(`attempt.status = '${ExamStatus.GRADED}'`)
          .andWhere('attempt.total_score >= :passingMarks', {
            passingMarks: row.passing_marks,
          })
          .getCount();

        const passRate =
          row.total_attempts > 0
            ? ((passCount / row.total_attempts) * 100).toFixed(1) + '%'
            : 'N/A';

        return { ...row, pass_rate: passRate };
      }),
    );

    return this.exportData(report, processedData, {
      filename: 'exam_analytics_report',
      title: 'Exam Analytics Report',
      subtitle: `${dateRange.startDate.toLocaleDateString()} - ${dateRange.endDate.toLocaleDateString()}`,
      fields: [
        'exam_title',
        'teacher_name',
        'total_attempts',
        'avg_score',
        'min_score',
        'max_score',
        'pass_rate',
      ],
      columns: [
        { key: 'exam_title', header: 'Exam Title', width: 140 },
        { key: 'teacher_name', header: 'Teacher', width: 100 },
        { key: 'total_attempts', header: 'Attempts', width: 60 },
        { key: 'avg_score', header: 'Avg Score', width: 60 },
        { key: 'min_score', header: 'Min', width: 40 },
        { key: 'max_score', header: 'Max', width: 40 },
        { key: 'pass_rate', header: 'Pass Rate', width: 60 },
      ],
    });
  }

  /**
   * Generate Content Performance Report
   */
  private async generateContentReport(
    report: Report,
  ): Promise<{ filePath: string; rowCount: number; fileSize: number }> {
    const filters = report.filters || {};
    const dateRange = this.getDateRange(filters);

    const query = this.lessonRepository
      .createQueryBuilder('lesson')
      .innerJoin('lesson.teacher', 'teacher')
      .innerJoin('lesson.subject', 'subject')
      .leftJoin('lesson.purchases', 'purchase')
      .select([
        'lesson.id as lesson_id',
        'lesson.title as lesson_title',
        "CONCAT(teacher.first_name, ' ', teacher.last_name) as teacher_name",
        'subject.title as subject_name',
        'lesson.price as price',
        'lesson.students_count as students_count',
        'COUNT(purchase.id) as purchases_count',
        'COALESCE(SUM(purchase.price_paid), 0) as total_revenue',
        'lesson.created_at as created_at',
      ])
      .where('lesson.deleted_at IS NULL')
      .andWhere('lesson.created_at BETWEEN :startDate AND :endDate', dateRange)
      .groupBy(
        'lesson.id, lesson.title, teacher.first_name, teacher.last_name, subject.title, lesson.price, lesson.students_count, lesson.created_at',
      )
      .orderBy('total_revenue', 'DESC');

    if (filters.subjectId) {
      query.andWhere('subject.id = :subjectId', {
        subjectId: filters.subjectId,
      });
    }

    const data = await query.limit(this.maxRows).getRawMany();

    return this.exportData(report, data, {
      filename: 'content_performance_report',
      title: 'Content Performance Report',
      subtitle: `${dateRange.startDate.toLocaleDateString()} - ${dateRange.endDate.toLocaleDateString()}`,
      fields: [
        'lesson_title',
        'teacher_name',
        'subject_name',
        'price',
        'students_count',
        'purchases_count',
        'total_revenue',
      ],
      columns: [
        { key: 'lesson_title', header: 'Lesson Title', width: 140 },
        { key: 'teacher_name', header: 'Teacher', width: 100 },
        { key: 'subject_name', header: 'Subject', width: 80 },
        { key: 'price', header: 'Price', width: 50 },
        { key: 'students_count', header: 'Students', width: 60 },
        { key: 'purchases_count', header: 'Purchases', width: 60 },
        { key: 'total_revenue', header: 'Revenue', width: 70 },
      ],
    });
  }

  /**
   * Export data to the appropriate format
   */
  private async exportData(
    report: Report,
    data: Record<string, unknown>[],
    options: {
      filename: string;
      title: string;
      subtitle: string;
      fields: string[];
      columns: { key: string; header: string; width?: number }[];
      summary?: Record<string, string | number>;
    },
  ): Promise<{ filePath: string; rowCount: number; fileSize: number }> {
    if (report.file_format === FileFormat.CSV) {
      return this.csvExporter.exportToCsv(data, {
        filename: options.filename,
        fields: options.fields,
      });
    } else {
      return this.pdfExporter.exportToPdf(data, {
        filename: options.filename,
        title: options.title,
        subtitle: options.subtitle,
        columns: options.columns,
        summary: options.summary,
      });
    }
  }

  /**
   * Get date range from filters with defaults
   */
  private getDateRange(filters: ReportFilters): {
    startDate: Date;
    endDate: Date;
  } {
    const endDate = filters.endDate ? new Date(filters.endDate) : new Date();
    const startDate = filters.startDate
      ? new Date(filters.startDate)
      : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    return { startDate, endDate };
  }

  /**
   * Get report by ID
   */
  async getReport(id: number): Promise<Report> {
    const report = await this.reportRepository.findOne({
      where: { id, deleted_at: IsNull() },
      relations: ['generator'],
    });

    if (!report) {
      throw new NotFoundException(`Report ${id} not found`);
    }

    return report;
  }

  /**
   * Get all reports with pagination
   */
  async getReports(
    page: number = 1,
    limit: number = 20,
    userId?: number,
  ): Promise<{ data: Report[]; meta: PaginationMeta }> {
    // Build where clause dynamically
    const whereClause: Record<string, unknown> = {
      deleted_at: IsNull(),
    };
    if (userId) {
      whereClause.generated_by = userId;
    }

    const [data, total] = await this.reportRepository.findAndCount({
      where: whereClause,
      relations: ['generator'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const totalPages = Math.ceil(total / limit);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Get file buffer for download
   */
  async getReportFile(id: number): Promise<{ buffer: Buffer; report: Report }> {
    const report = await this.getReport(id);

    if (report.status !== ReportStatus.COMPLETED || !report.file_path) {
      throw new NotFoundException('Report file not available');
    }

    const buffer =
      report.file_format === FileFormat.CSV
        ? await this.csvExporter.getFileBuffer(report.file_path)
        : await this.pdfExporter.getFileBuffer(report.file_path);

    return { buffer, report };
  }

  /**
   * Delete a report
   */
  async deleteReport(id: number): Promise<void> {
    const report = await this.getReport(id);

    // Delete file if exists
    if (report.file_path) {
      if (report.file_format === FileFormat.CSV) {
        await this.csvExporter.deleteFile(report.file_path);
      } else {
        await this.pdfExporter.deleteFile(report.file_path);
      }
    }

    // Soft delete
    await this.reportRepository.softDelete(id);
    this.logger.log(`Report deleted: ${id}`);
  }

  /**
   * Cleanup old reports
   */
  async cleanupOldReports(): Promise<number> {
    const retentionDays = parseInt(
      process.env.REPORTS_RETENTION_DAYS || '7',
      10,
    );

    // Clean up files
    const deletedFiles =
      await this.csvExporter.cleanupOldReports(retentionDays);

    // Soft delete old report records
    const cutoffDate = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    );

    const result = await this.reportRepository
      .createQueryBuilder()
      .softDelete()
      .where('created_at < :cutoffDate', { cutoffDate })
      .andWhere('deleted_at IS NULL')
      .execute();

    this.logger.log(
      `Cleaned up ${deletedFiles} files and ${result.affected} records`,
    );

    return deletedFiles + (result.affected || 0);
  }
}
