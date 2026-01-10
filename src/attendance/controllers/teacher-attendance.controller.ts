import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  HttpStatus,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AttendanceService } from '../attendance.service';
import { MarkAttendanceDto, AttendanceFilterDto } from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { AttendanceStatus } from '../entities';

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
    lessonId: number,
    teacherId: string,
  ): Promise<Lesson> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId, deleted_at: IsNull() },
    });

    if (!lesson) {
      throw new ForbiddenException(`Lesson with ID ${lessonId} not found`);
    }

    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException(
        'You can only manage attendance for your own lessons',
      );
    }

    return lesson;
  }

  /**
   * Mark attendance for a student in a lesson
   */
  @Post(':lessonId/attendance')
  @ApiOperation({
    summary: 'Mark attendance',
    description:
      'Mark attendance for a student in a lesson. Teacher must own the lesson.',
  })
  @ApiParam({ name: 'lessonId', description: 'Lesson ID' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Attendance marked successfully',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Attendance already marked',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only manage attendance for your own lessons',
  })
  async markAttendance(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Body() dto: MarkAttendanceDto,
  ) {
    // Validate ownership
    await this.validateOwnership(lessonId, user.userId);

    // Override lesson_id from path
    const attendance = await this.attendanceService.markAttendance(
      user.userId,
      { ...dto, lesson_id: lessonId },
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
  @Put(':lessonId/attendance/:id')
  @ApiOperation({
    summary: 'Update attendance',
    description:
      'Update an existing attendance record. Teacher must own the lesson.',
  })
  @ApiParam({ name: 'lessonId', description: 'Lesson ID' })
  @ApiParam({ name: 'id', description: 'Attendance record ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Attendance updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Attendance record not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only manage attendance for your own lessons',
  })
  async updateAttendance(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body('status') status: AttendanceStatus,
    @Body('notes') notes?: string,
  ) {
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
  @Delete(':lessonId/attendance/:id')
  @ApiOperation({
    summary: 'Delete attendance',
    description: 'Delete an attendance record. Teacher must own the lesson.',
  })
  @ApiParam({ name: 'lessonId', description: 'Lesson ID' })
  @ApiParam({ name: 'id', description: 'Attendance record ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Attendance deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Attendance record not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only manage attendance for your own lessons',
  })
  async deleteAttendance(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
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
    status: HttpStatus.OK,
    description: 'Lesson attendance retrieved',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only view attendance for your own lessons',
  })
  async getLessonAttendance(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Query() filter: AttendanceFilterDto,
  ) {
    // Validate ownership
    await this.validateOwnership(lessonId, user.userId);

    return this.attendanceService.getLessonAttendance(lessonId, filter);
  }

  /**
   * Get attendance statistics for a lesson
   */
  @Get(':lessonId/attendance/stats')
  @ApiOperation({
    summary: 'Get lesson attendance stats',
    description:
      'Get attendance statistics for a lesson. Teacher must own the lesson.',
  })
  @ApiParam({ name: 'lessonId', description: 'Lesson ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lesson attendance statistics retrieved',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only view stats for your own lessons',
  })
  async getLessonStats(
    @GetUser() user: JwtPayload,
    @Param('lessonId', ParseIntPipe) lessonId: number,
  ) {
    // Validate ownership
    await this.validateOwnership(lessonId, user.userId);

    return this.attendanceService.getLessonAttendanceStats(lessonId);
  }
}
