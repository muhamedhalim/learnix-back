import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
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
import { AttendanceFilterDto, MarkAttendanceDto, UpdateAttendanceDto } from '../dto';

@ApiTags('Teacher Attendance')
@Controller('teacher/lessons')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherAttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  /**
   * Mark attendance for a student in a lesson
   */
  @Post(':lessonId/attendance')
  @ApiOperation({ summary: 'Manually mark student attendance' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Attendance marked successfully',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only manage attendance for your own lessons',
  })
  public async markAttendance(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: MarkAttendanceDto,
  ): Promise<{ message: string; data: unknown }> {
    // Validate ownership
    await this.attendanceService.assertTeacherOwnsLesson(lessonId, user.userId);

    // Override lesson_id from path
    const attendance = await this.attendanceService.markAttendance(
      user.userId,
      Object.assign({}, dto, { lesson_id: lessonId }),
      false,
    );

    return {
      message: 'Attendance marked successfully',
      data: attendance,
    };
  }

  @Post(':lessonId/sessions/:sessionId/attendance')
  @ApiOperation({ summary: 'Mark attendance for a confirmed one-to-one appointment' })
  public async markScheduledSessionAttendance(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: MarkAttendanceDto,
  ): Promise<{ message: string; data: unknown }> {
    await this.attendanceService.assertTeacherOwnsLesson(lessonId, user.userId);
    const attendance = await this.attendanceService.markScheduledSessionAttendance(
      user.userId,
      lessonId,
      sessionId,
      Object.assign({}, dto, { lesson_id: lessonId }),
    );
    return { message: 'Attendance marked successfully', data: attendance };
  }

  /**
   * Update attendance record
   */
  @Patch(':lessonId/attendance/:id')
  @ApiOperation({ summary: 'Update an existing attendance record' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Attendance updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only manage attendance for your own lessons',
  })
  public async updateAttendance(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAttendanceDto,
  ): Promise<{ message: string; data: unknown }> {
    // Validate ownership
    await this.attendanceService.assertTeacherOwnsLesson(lessonId, user.userId);

    const attendance = await this.attendanceService.updateAttendance(
      id,
      lessonId,
      user.userId,
      dto.status,
      dto.notes,
    );

    return {
      message: 'Attendance updated successfully',
      data: attendance,
    };
  }

  /**
   * Delete attendance record
   */
  @Delete(':lessonId/attendance/:id')
  @ApiOperation({ summary: 'Delete an attendance record' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Attendance deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only manage attendance for your own lessons',
  })
  public async deleteAttendance(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ message: string }> {
    // Validate ownership
    await this.attendanceService.assertTeacherOwnsLesson(lessonId, user.userId);

    await this.attendanceService.deleteAttendance(id, lessonId);

    return {
      message: 'Attendance deleted successfully',
    };
  }

  /**
   * Get attendance for a lesson
   */
  @Get(':lessonId/attendance')
  @ApiOperation({
    summary: 'Get lesson attendance',
    description: 'Get all attendance records for a lesson. Teacher must own the lesson.',
  })
  @ApiParam({ name: 'lessonId', description: 'Lesson ID' })
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
    description: 'Items per page (default: 50)',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only view attendance for your own lessons',
  })
  public async getLessonAttendance(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Query() filter: AttendanceFilterDto,
  ): Promise<unknown> {
    // Validate ownership
    await this.attendanceService.assertTeacherOwnsLesson(lessonId, user.userId);

    return await this.attendanceService.getLessonAttendance(lessonId, filter);
  }

  /**
   * Get attendance statistics for a lesson
   */
  @Get(':lessonId/attendance/stats')
  @ApiOperation({ summary: 'Get attendance stats for a lesson' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Stats retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only view stats for your own lessons',
  })
  public async getLessonStats(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<unknown> {
    // Validate ownership
    await this.attendanceService.assertTeacherOwnsLesson(lessonId, user.userId);

    return await this.attendanceService.getLessonAttendanceStats(lessonId);
  }
}
