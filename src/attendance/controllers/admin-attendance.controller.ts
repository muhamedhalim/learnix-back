import { Controller, Get, HttpStatus, Logger, Param, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AttendanceService } from '../attendance.service';
import { AttendanceExportService } from '../attendance-export.service';
import type { AttendanceExportFormat } from '../attendance-export.service';
import { AttendanceFilterDto } from '../dto';
import type { Response } from 'express';

/**
 * The explicit, documented ceiling on a single attendance export, per format.
 *
 * These exist so an oversized export FAILS LOUDLY instead of being quietly
 * cut short — the DEF-008 defect was an undocumented 100-row cap applied
 * silently to every format. CSV and XLSX both stream row-by-row and are bound
 * only by how long a client will hold a download open; PDF is far more
 * expensive per row (layout + page breaks), so it gets a lower ceiling.
 */
export const ATTENDANCE_EXPORT_LIMITS: Record<AttendanceExportFormat, number> = {
  csv: 250_000,
  xlsx: 250_000,
  pdf: 20_000,
};

@ApiTags('Admin Attendance')
@Controller('admin/attendance')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminAttendanceController {
  private readonly logger = new Logger(AdminAttendanceController.name);

  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly attendanceExportService: AttendanceExportService,
  ) {}

  /**
   * Get all attendance records
   */
  @Get()
  @ApiOperation({
    summary: 'Get all attendance',
    description: 'Returns all attendance records with filters. Admin only.',
  })
  @ApiQuery({
    name: 'student_id',
    required: false,
    type: Number,
    description: 'Filter by student ID',
  })
  @ApiQuery({
    name: 'lesson_id',
    required: false,
    type: Number,
    description: 'Filter by lesson ID',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['present', 'absent', 'late', 'excused'],
    description: 'Filter by status',
  })
  @ApiQuery({
    name: 'from_date',
    required: false,
    type: String,
    description: 'Filter from date (ISO format)',
  })
  @ApiQuery({
    name: 'to_date',
    required: false,
    type: String,
    description: 'Filter to date (ISO format)',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 20)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'All attendance records retrieved',
  })
  public async getAllAttendance(@Query() filter: AttendanceFilterDto): Promise<unknown> {
    return await this.attendanceService.getAllAttendance(filter);
  }

  /**
   * Export the COMPLETE filtered result set — every matching record, not a
   * page of it (DEF-008).
   *
   * The rows are read from the database in bounded keyset chunks and streamed
   * straight into the chosen writer, so the exported row count always equals
   * the filtered row count. The only bound is `ATTENDANCE_EXPORT_LIMITS`,
   * which is checked BEFORE a byte is written and reported as an explicit 422
   * telling the admin to narrow their filters. Nothing is ever silently
   * dropped.
   *
   * `page` and `limit` on the query are deliberately ignored here: list
   * pagination and export completeness are separate concerns.
   */
  @Get('export/:format')
  @ApiOperation({
    summary: 'Export ALL filtered attendance records as CSV, Excel, or PDF',
    description:
      'Streams every record matching the supplied filters. `page`/`limit` are ignored. ' +
      'Exports above the documented per-format maximum are rejected with 422 rather than truncated.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Complete filtered export file' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'The filtered result set exceeds the maximum exportable size for this format',
  })
  public async exportAttendance(
    @Param('format') format: AttendanceExportFormat,
    @Query() filter: AttendanceFilterDto,
    @Res() response: Response,
  ): Promise<void> {
    if (!['csv', 'xlsx', 'pdf'].includes(format)) {
      response
        .status(HttpStatus.BAD_REQUEST)
        .json({ message: 'Unsupported attendance export format' });
      return;
    }

    const total = await this.attendanceService.countAttendanceForExport(filter);
    const maximum = ATTENDANCE_EXPORT_LIMITS[format];
    if (total > maximum) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        message: `This export matches ${String(total)} records, above the ${String(maximum)}-record maximum for ${format.toUpperCase()}. Narrow the date range or filters and try again.`,
        total,
        maximum,
        format,
      });
      return;
    }

    const descriptor = this.attendanceExportService.describe(format);
    response.setHeader('Content-Type', descriptor.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${descriptor.filename}"`);

    try {
      const written = await this.attendanceExportService.write(
        this.attendanceService.iterateAttendanceForExport(filter),
        format,
        response,
        { total, generatedAt: new Date(), filters: describeFilters(filter) },
      );
      if (written !== total) {
        // Rows created or deleted while the export streamed. The file is still
        // internally consistent, but say so rather than let the count drift
        // silently — a trustworthy row count is the whole point of DEF-008.
        this.logger.warn(
          `Attendance ${format} export wrote ${String(written)} row(s) against a pre-flight count of ${String(total)}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Attendance ${format} export failed after headers were sent`,
        error instanceof Error ? error.stack : undefined,
      );
      // Headers (and probably bytes) are already out, so a clean error body is
      // impossible. Abort the transfer instead: the client sees a broken
      // download, never a short file that looks complete.
      response.destroy(error instanceof Error ? error : new Error('Attendance export failed'));
    }
  }
}

/** Filter provenance recorded inside the exported document. */
function describeFilters(filter: AttendanceFilterDto): Record<string, string> {
  const described: Record<string, string> = {};
  if (filter.student_id) described['student_id'] = filter.student_id;
  if (filter.lesson_id) described['lesson_id'] = filter.lesson_id;
  if (filter.status) described['status'] = filter.status;
  if (filter.from_date) described['from_date'] = filter.from_date;
  if (filter.to_date) described['to_date'] = filter.to_date;
  return described;
}
