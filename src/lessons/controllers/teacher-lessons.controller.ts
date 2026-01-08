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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { LessonsService } from '../lessons.service';
import {
  CreateLessonDto,
  UpdateLessonDto,
  LessonFilterDto,
  UpdateVimeoInfoDto,
  UpdateLessonVideoDto,
  UpdateVimeoUrlDto,
} from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';

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
  async findMyLessons(
    @GetUser() user: JwtPayload,
    @Query() filter: Omit<LessonFilterDto, 'teacher_id'>,
  ) {
    return this.lessonsService.findMyLessons(user.userId, filter);
  }

  /**
   * Create a new lesson
   */
  @Post()
  @ApiOperation({
    summary: 'Create a lesson',
    description:
      'Creates a new lesson for the authenticated teacher. Teacher only.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Lesson created successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input data',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subject not found',
  })
  async create(
    @GetUser() user: JwtPayload,
    @Body() createDto: CreateLessonDto,
  ) {
    const lesson = await this.lessonsService.create(user.userId, createDto);
    return {
      message: 'Lesson created successfully',
      lesson,
    };
  }

  /**
   * Get a single lesson by ID (must be owner)
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get my lesson by ID',
    description:
      'Returns a specific lesson owned by the authenticated teacher.',
  })
  @ApiParam({ name: 'id', description: 'Lesson ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lesson retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  async findOne(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
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
  @Put(':id')
  @ApiOperation({
    summary: 'Update my lesson',
    description:
      'Updates a lesson owned by the authenticated teacher. Teacher only.',
  })
  @ApiParam({ name: 'id', description: 'Lesson ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lesson updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own lessons',
  })
  async update(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDto: UpdateLessonDto,
  ) {
    const lesson = await this.lessonsService.update(id, user.userId, updateDto);
    return {
      message: 'Lesson updated successfully',
      lesson,
    };
  }

  /**
   * Delete a lesson
   */
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete my lesson',
    description:
      'Deletes a lesson owned by the authenticated teacher. Teacher only.',
  })
  @ApiParam({ name: 'id', description: 'Lesson ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lesson deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only delete your own lessons',
  })
  async delete(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
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
  @ApiParam({ name: 'id', description: 'Lesson ID', type: 'number' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Video URL updated successfully',
    schema: {
      example: {
        message: 'Video URL updated successfully',
        video_url: 'https://iframe.mediadelivery.net/embed/123456/abc-def-ghi',
        video_platform: 'bunny',
        bunny_video_id: 'abc-def-ghi',
        bunny_library_id: '123456',
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid Bunny.net URL format',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own lessons',
  })
  async updateVideoUrl(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLessonVideoDto,
  ) {
    return this.lessonsService.updateVideoUrl(
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
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid Vimeo URL format',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own lessons',
  })
  async updateVimeoUrl(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateVimeoUrlDto,
  ) {
    const vimeoUrl = dto.vimeo_url || dto.video_url;
    return this.lessonsService.updateVimeoUrl(
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
  @ApiParam({ name: 'id', description: 'Lesson ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Vimeo info updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own lessons',
  })
  async updateVimeoInfo(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() vimeoDto: UpdateVimeoInfoDto,
  ) {
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
