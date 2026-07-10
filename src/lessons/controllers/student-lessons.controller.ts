import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
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
import type { UserRequest } from '../../common/interfaces/user-request.interface';
import { PaymentsService } from '../../payments/services/payments.service';
import {
  AllProgressResponseDto,
  LessonFilterDto,
  LessonProgressNullableResponseDto,
  LessonProgressResponseDto,
  UpdateProgressDto,
} from '../dto';
import { LessonsService } from '../lessons.service';
import { ProgressService } from '../progress.service';

@ApiTags('Student Lessons')
@Controller('student/lessons')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentLessonsController {
  constructor(
    private readonly lessonsService: LessonsService,
    private readonly progressService: ProgressService,
    private readonly paymentsService: PaymentsService,
  ) {}

  /**
   * Browse available lessons
   * Returns lessons that the student can purchase
   */
  @Get()
  @ApiOperation({
    summary: 'Browse available lessons',
    description:
      'Returns a paginated list of available lessons for the student to purchase. Student only.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by title',
  })
  @ApiQuery({
    name: 'subject_id',
    required: false,
    type: Number,
    description: 'Filter by subject ID',
  })
  @ApiQuery({
    name: 'teacher_id',
    required: false,
    type: Number,
    description: 'Filter by teacher ID',
  })
  @ApiQuery({
    name: 'minPrice',
    required: false,
    type: Number,
    description: 'Minimum price filter',
  })
  @ApiQuery({
    name: 'maxPrice',
    required: false,
    type: Number,
    description: 'Maximum price filter',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['price', 'title', 'created_at', 'students_count'],
    description: 'Sort by field (default: created_at)',
  })
  @ApiQuery({
    name: 'order',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort order (default: desc)',
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
    description: 'List of available lessons',
  })
  public async browseLessons(
    @Query() filter: LessonFilterDto,
  ): Promise<unknown> {
    return await this.lessonsService.findAll(filter);
  }

  /**
   * Update progress for a lesson
   * Records the student's watch progress
   */
  @Post(':lessonId/progress')
  @ApiOperation({
    summary: 'Update lesson progress',
    description:
      'Records or updates the student watch progress for a specific lesson. Uses upsert pattern.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Progress updated successfully',
    type: LessonProgressResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid progress data',
  })
  public async updateProgress(
    @Request() req: UserRequest,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: UpdateProgressDto,
  ): Promise<LessonProgressResponseDto> {
    const userId = req.user?.userId;
    if (userId === undefined || userId === '') {
      throw new ForbiddenException('User not authenticated');
    }

    // Recording watch progress implies the student is actively watching, so
    // gate it by the same entitlement rule as actual playback (unexpired
    // direct purchase, or a package purchase covering this lesson) — a
    // student whose access has expired must not be able to keep progress
    // ticking on this lesson.
    const hasAccess = await this.paymentsService.hasLessonPlaybackAccess(
      userId,
      lessonId,
    );
    if (!hasAccess) {
      throw new ForbiddenException(
        'You must have active access to this lesson to record progress.',
      );
    }

    const progress = await this.progressService.updateProgress(
      userId,
      lessonId,
      dto.watchedDuration,
      dto.totalDuration,
    );

    return {
      message: 'Progress updated successfully',
      data: progress,
    };
  }

  /**
   * Get progress for a specific lesson
   * Returns the student's watch progress or null if no progress exists
   */
  @Get(':lessonId/progress')
  @ApiOperation({
    summary: 'Get lesson progress',
    description:
      'Returns the student watch progress for a specific lesson, or null if no progress exists.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Progress data or null',
    type: LessonProgressNullableResponseDto,
  })
  public async getProgress(
    @Request() req: UserRequest,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<LessonProgressNullableResponseDto> {
    const userId = req.user?.userId;
    if (userId === undefined || userId === '') {
      throw new ForbiddenException('User not authenticated');
    }

    const progress = await this.progressService.getProgress(userId, lessonId);

    return { data: progress };
  }

  /**
   * Get all progress records for the student
   * Returns all lessons with their watch progress
   */
  @Get('my/progress')
  @ApiOperation({
    summary: 'Get all lesson progress',
    description:
      'Returns all lessons with their watch progress for the current student.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Array of progress records',
    type: AllProgressResponseDto,
  })
  public async getAllProgress(
    @Request() req: UserRequest,
  ): Promise<AllProgressResponseDto> {
    const userId = req.user?.userId;
    if (userId === undefined || userId === '') {
      throw new ForbiddenException('User not authenticated');
    }

    const progressRecords = await this.progressService.getAllProgress(userId);

    return { data: progressRecords };
  }
}
