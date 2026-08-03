import { Controller, Get, HttpStatus, Param, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AttendanceService } from '../attendance.service';
import { AttendanceExportService } from '../attendance-export.service';
import type { AttendanceExportFormat } from '../attendance-export.service';
import { AttendanceFilterDto } from '../dto';
import type { Response } from 'express';

@ApiTags('Admin Attendance')
@Controller('admin/attendance')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminAttendanceController {
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

  @Get('export/:format')
  @ApiOperation({ summary: 'Export filtered attendance as CSV, Excel, or PDF' })
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
    const { data } = await this.attendanceService.getAllAttendance({
      ...filter,
      page: 1,
      limit: 100,
    });
    const result = await this.attendanceExportService.create(data, format);
    response.setHeader('Content-Type', result.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    response.send(result.body);
  }
}
