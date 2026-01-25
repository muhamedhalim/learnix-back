import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { InjectRepository } from '@nestjs/typeorm';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { AttendanceService } from '../attendance.service';
import { AttendanceFilterDto,MarkAttendanceDto } from '../dto';
import type { AttendanceStatus } from '../entities';
import { IsNull,Repository } from 'typeorm';

@ApiTags('Teacher Attendance')
@Controller('teacher/lessons')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherAttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
  ) {}

  /**
   * Validate teacher owns the lesson
   */
  private async validateOwnership(
    lessonId: string,
    teacherId: string,
  ): Promise<Lesson> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId, deleted_at: IsNull() },
    });

    if(!lesson) {
      throw new ForbiddenException(`Lesson with ID ${lessonId} not found`);
    }

    if(lesson.teacher_id !== teacherId) {
      throw new ForbiddenException(
        'You can only manage attendance for your own lessons',
      );
    }

    return lesson;
  }

  /**
   * Mark attendance for a student in a lesson
   */
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
    await this.validateOwnership(lessonId, user.userId);

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

  /**
   * Update attendance record
   */
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only manage attendance for your own lessons',
  })
  public async updateAttendance(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('status') status: AttendanceStatus,
    @Body('notes') notes?: string,
  ): Promise<{ message: string; data: unknown }> {
    // Validate ownership
    await this.validateOwnership(lessonId, user.userId);

    const attendance = await this.attendanceService.updateAttendance(
      id,
      user.userId,
      status,
      notes,
    );

    return {
      message: 'Attendance updated successfully',
      data: attendance,
    };
  }

  /**
   * Delete attendance record
   */
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
    await this.validateOwnership(lessonId, user.userId);

    await this.attendanceService.deleteAttendance(id);

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
    description:
      'Get all attendance records for a lesson. Teacher must own the lesson.',
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
    await this.validateOwnership(lessonId, user.userId);

    return this.attendanceService.getLessonAttendance(lessonId, filter);
  }

  /**
   * Get attendance statistics for a lesson
   */
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only view stats for your own lessons',
  })
  public async getLessonStats(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<unknown> {
    // Validate ownership
    await this.validateOwnership(lessonId, user.userId);

    return this.attendanceService.getLessonAttendanceStats(lessonId);
  }
}
