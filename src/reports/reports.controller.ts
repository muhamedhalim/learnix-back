import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  Res,
  Request,
  ParseIntPipe,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import {
  GenerateStudentReportDto,
  GenerateTeacherReportDto,
  GenerateRevenueReportDto,
  GenerateExamReportDto,
  GenerateContentReportDto,
} from './dto';
import { Report, ReportType, FileFormat } from './entities';
import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRequest } from '../common/interfaces/user-request.interface';

@ApiTags('Admin Reports')
@ApiBearerAuth('JWT-auth')
@Controller('admin/reports')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // ==================== REPORT GENERATION ====================

  @Post('students')
  @ApiOperation({
    summary: 'Generate student performance report',
    description:
      'Queues a student performance report for generation. Returns immediately with report metadata.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Report queued for generation',
    type: Report,
  })
  async generateStudentReport(
    @Body() dto: GenerateStudentReportDto,
    @Request() req: UserRequest,
  ): Promise<{ message: string; data: Report }> {
    const report = await this.reportsService.createReport(
      ReportType.STUDENT_PERFORMANCE,
      dto.format || FileFormat.CSV,
      {
        startDate: dto.startDate,
        endDate: dto.endDate,
        studentIds: dto.studentIds,
        subjectId: dto.subjectId,
      },
      req.user.userId,
    );

    // Process immediately for now (can be moved to background queue)
    this.reportsService.processReport(report.id).catch((err) => {
      console.error(`Failed to process report ${report.id}:`, err);
    });

    return {
      message: 'Student performance report queued for generation',
      data: report,
    };
  }

  @Post('teachers')
  @ApiOperation({
    summary: 'Generate teacher engagement report',
    description:
      'Queues a teacher engagement report for generation. Returns immediately with report metadata.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Report queued for generation',
    type: Report,
  })
  async generateTeacherReport(
    @Body() dto: GenerateTeacherReportDto,
    @Request() req: UserRequest,
  ): Promise<{ message: string; data: Report }> {
    const report = await this.reportsService.createReport(
      ReportType.TEACHER_ENGAGEMENT,
      dto.format || FileFormat.CSV,
      {
        startDate: dto.startDate,
        endDate: dto.endDate,
        teacherIds: dto.teacherIds,
        subjectId: dto.subjectId,
      },
      req.user.userId,
    );

    this.reportsService.processReport(report.id).catch((err) => {
      console.error(`Failed to process report ${report.id}:`, err);
    });

    return {
      message: 'Teacher engagement report queued for generation',
      data: report,
    };
  }

  @Post('revenue')
  @ApiOperation({
    summary: 'Generate financial/revenue report',
    description:
      'Queues a financial report for generation. Returns immediately with report metadata.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Report queued for generation',
    type: Report,
  })
  async generateRevenueReport(
    @Body() dto: GenerateRevenueReportDto,
    @Request() req: UserRequest,
  ): Promise<{ message: string; data: Report }> {
    const report = await this.reportsService.createReport(
      ReportType.FINANCIAL,
      dto.format || FileFormat.CSV,
      {
        startDate: dto.startDate,
        endDate: dto.endDate,
        paymentMethod: dto.paymentMethod,
        subjectId: dto.subjectId,
      },
      req.user.userId,
    );

    this.reportsService.processReport(report.id).catch((err) => {
      console.error(`Failed to process report ${report.id}:`, err);
    });

    return {
      message: 'Financial report queued for generation',
      data: report,
    };
  }

  @Post('exams')
  @ApiOperation({
    summary: 'Generate exam analytics report',
    description:
      'Queues an exam analytics report for generation. Returns immediately with report metadata.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Report queued for generation',
    type: Report,
  })
  async generateExamReport(
    @Body() dto: GenerateExamReportDto,
    @Request() req: UserRequest,
  ): Promise<{ message: string; data: Report }> {
    const report = await this.reportsService.createReport(
      ReportType.EXAM_ANALYTICS,
      dto.format || FileFormat.CSV,
      {
        startDate: dto.startDate,
        endDate: dto.endDate,
        examIds: dto.examIds,
        teacherId: dto.teacherId,
      },
      req.user.userId,
    );

    this.reportsService.processReport(report.id).catch((err) => {
      console.error(`Failed to process report ${report.id}:`, err);
    });

    return {
      message: 'Exam analytics report queued for generation',
      data: report,
    };
  }

  @Post('content')
  @ApiOperation({
    summary: 'Generate content performance report',
    description:
      'Queues a content performance report for generation. Returns immediately with report metadata.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Report queued for generation',
    type: Report,
  })
  async generateContentReport(
    @Body() dto: GenerateContentReportDto,
    @Request() req: UserRequest,
  ): Promise<{ message: string; data: Report }> {
    const report = await this.reportsService.createReport(
      ReportType.CONTENT_PERFORMANCE,
      dto.format || FileFormat.CSV,
      {
        startDate: dto.startDate,
        endDate: dto.endDate,
        subjectId: dto.subjectId,
      },
      req.user.userId,
    );

    this.reportsService.processReport(report.id).catch((err) => {
      console.error(`Failed to process report ${report.id}:`, err);
    });

    return {
      message: 'Content performance report queued for generation',
      data: report,
    };
  }

  // ==================== REPORT MANAGEMENT ====================

  @Get()
  @ApiOperation({
    summary: 'List all reports',
    description: 'Get paginated list of generated reports',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of reports with pagination',
  })
  async getReports(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<{ data: Report[]; meta: object }> {
    return this.reportsService.getReports(page || 1, limit || 20);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get report details',
    description: 'Get report status and metadata by ID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report details',
    type: Report,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Report not found',
  })
  async getReport(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ data: Report }> {
    const report = await this.reportsService.getReport(id);
    return { data: report };
  }

  @Get(':id/download')
  @ApiOperation({
    summary: 'Download report file',
    description: 'Download the generated report file (CSV or PDF)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report file download',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Report or file not found',
  })
  async downloadReport(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, report } = await this.reportsService.getReportFile(id);

    const contentType =
      report.file_format === FileFormat.CSV ? 'text/csv' : 'application/pdf';

    const filename = report.file_path
      ? report.file_path.split(/[/\\]/).pop()
      : `report_${report.id}.${report.file_format}`;

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });

    res.send(buffer);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a report',
    description: 'Soft delete a report and its associated file',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Report not found',
  })
  async deleteReport(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ message: string }> {
    await this.reportsService.deleteReport(id);
    return { message: 'Report deleted successfully' };
  }

  // ==================== MAINTENANCE ====================

  @Post('cleanup')
  @ApiOperation({
    summary: 'Cleanup old reports',
    description: 'Remove reports older than retention period (default 7 days)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Cleanup completed',
  })
  async cleanupOldReports(): Promise<{
    message: string;
    deletedCount: number;
  }> {
    const deletedCount = await this.reportsService.cleanupOldReports();
    return {
      message: `Cleanup completed`,
      deletedCount,
    };
  }
}
