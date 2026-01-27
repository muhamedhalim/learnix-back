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
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { AttendanceService } from '../attendance.service';
import { AttendanceFilterDto } from '../dto';

@ApiTags('Student Attendance')
@Controller('student/attendance')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentAttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  /**
   * Get my attendance history
   */
  @Get()
  @ApiOperation({
    summary: 'Get my attendance',
    description:
      "Returns the authenticated student's attendance history with filters.",
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
    description: 'Attendance history retrieved',
  })
  public async getMyAttendance(
    @GetUser() user: JwtPayload,
    @Query() filter: AttendanceFilterDto,
  ): Promise<unknown> {
    return await this.attendanceService.getStudentAttendance(
      user.userId,
      filter,
    );
  }

  /**
   * Get my attendance statistics
   */
  @Get('stats')
  @ApiOperation({
    summary: 'Get my attendance stats',
    description:
      "Returns the authenticated student's attendance statistics (total, present, absent, etc.).",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Attendance statistics retrieved',
  })
  public async getMyStats(@GetUser() user: JwtPayload): Promise<unknown> {
    return await this.attendanceService.getStudentAttendanceStats(user.userId);
  }
}
