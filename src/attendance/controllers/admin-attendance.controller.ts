import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AttendanceService } from '../attendance.service';
import { AttendanceFilterDto } from '../dto';

@ApiTags('Admin Attendance')
@Controller('admin/attendance')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminAttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

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
  public async getAllAttendance(
    @Query() filter: AttendanceFilterDto,
  ): Promise<unknown> {
    return await this.attendanceService.getAllAttendance(filter);
  }
}
