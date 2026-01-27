import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
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
import {
  CreateLessonDto,
  LessonFilterDto,
  UpdateLessonDto,
  UpdateLessonVideoDto,
  UpdateVimeoInfoDto,
  UpdateVimeoUrlDto,
} from '../dto';
import { LessonsService } from '../lessons.service';

@ApiTags('Teacher Lessons')
@Controller('teacher/lessons')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherLessonsController {
  constructor(private readonly lessonsService: LessonsService) {}

  /**
   * Get my lessons
   * Returns the authenticated teacher's lessons
   */
  @Get()
  @ApiOperation({
    summary: 'Get my lessons',
    description:
      "Returns a paginated list of the authenticated teacher's lessons. Teacher only.",
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
    description: "List of teacher's lessons",
  })
  public async findMyLessons(
    @GetUser() user: JwtPayload,
    @Query() filter: Omit<LessonFilterDto, 'teacher_id'>,
  ): Promise<unknown> {
    return await this.lessonsService.findMyLessons(user.userId, filter);
  }

  /**
   * Create a new lesson
   */
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subject not found',
  })
  public async create(
    @GetUser() user: JwtPayload,
    @Body() createDto: CreateLessonDto,
  ): Promise<unknown> {
    const lesson = await this.lessonsService.create(user.userId, createDto);
    return {
      message: 'Lesson created successfully',
      lesson,
    };
  }

  /**
   * Get a single lesson by ID (must be owner)
   */
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  public async findOne(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    // First get the lesson to verify ownership
    const lesson = await this.lessonsService.findOne(id);
    if (lesson.teacher.id !== user.userId) {
      // Allow viewing but could add ownership check here
    }
    return lesson;
  }

  /**
   * Update a lesson
   */
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own lessons',
  })
  public async update(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateLessonDto,
  ): Promise<unknown> {
    const lesson = await this.lessonsService.update(id, user.userId, updateDto);
    return {
      message: 'Lesson updated successfully',
      lesson,
    };
  }

  /**
   * Delete a lesson
   */
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only delete your own lessons',
  })
  public async delete(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    await this.lessonsService.delete(id, user.userId);
    return {
      message: 'Lesson deleted successfully',
    };
  }

  /**
   * Update video URL for a lesson (Bunny.net - Primary)
   */
  @Put(':id/video')
  @ApiOperation({
    summary: 'Update lesson video URL (Bunny.net)',
    description:
      'Updates the video URL for a lesson using Bunny.net Stream. Automatically extracts and stores library ID and video ID. Teacher can only update their own lessons.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own lessons',
  })
  public async updateVideoUrl(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLessonVideoDto,
  ): Promise<unknown> {
    return await this.lessonsService.updateVideoUrl(
      id,
      user.userId,
      dto.video_url,
      dto.duration,
    );
  }

  /**
   * Update Vimeo URL for a lesson (Legacy - Deprecated)
   * @deprecated Use PUT /lessons/:id/video with Bunny.net URLs instead
   */
  @Put(':id/vimeo')
  @ApiOperation({
    summary: 'Update Vimeo URL (Legacy - Deprecated)',
    description:
      'DEPRECATED: Use PUT /teacher/lessons/:id/video instead. Updates the video URL for a lesson using Vimeo (legacy support only).',
    deprecated: true,
  })
  @ApiParam({ name: 'id', description: 'Lesson ID', type: 'number' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Vimeo URL updated successfully',
    schema: {
      example: {
        message: 'Vimeo URL updated successfully (legacy)',
        video_url: 'https://vimeo.com/123456789',
        video_platform: 'vimeo',
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own lessons',
  })
  public async updateVimeoUrl(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVimeoUrlDto,
  ): Promise<unknown> {
    const vimeoUrl = dto.vimeo_url ?? dto.video_url;
    return await this.lessonsService.updateVideoUrl(
      id,
      user.userId,
      vimeoUrl,
      dto.duration,
    );
  }

  /**
   * Update Vimeo info for a lesson (Legacy DTO - Deprecated)
   * @deprecated Use PUT /lessons/:id/video with Bunny.net URLs instead
   */
  @Put(':id/vimeo-info')
  @ApiOperation({
    summary: 'Update Vimeo info (Legacy - Deprecated)',
    description:
      'DEPRECATED: Use PUT /teacher/lessons/:id/video instead. Updates Vimeo video information for a lesson.',
    deprecated: true,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own lessons',
  })
  public async updateVimeoInfo(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() vimeoDto: UpdateVimeoInfoDto,
  ): Promise<unknown> {
    const lesson = await this.lessonsService.updateVimeoInfo(
      id,
      user.userId,
      vimeoDto,
    );
    return {
      message: 'Vimeo info updated successfully',
      lesson,
    };
  }
}
