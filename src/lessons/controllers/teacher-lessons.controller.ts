import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import {
  CreateLessonDto,
  SetLessonVisibilityDto,
  TeacherLessonFilterDto,
  UpdateLessonDto,
} from '../dto';
import { LessonsService } from '../lessons.service';
import { IsInt, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { LessonAwsVideoService } from '../lesson-aws-video.service';

export class StartAwsVideoUploadDto {
  @IsString()
  @MaxLength(255)
  public filename!: string;

  @IsString()
  @MaxLength(150)
  public content_type!: string;

  @IsInt()
  @Min(1)
  public size!: number;
}

export class CompleteAwsVideoUploadDto {
  @IsUUID()
  public upload_id!: string;
}

@ApiTags('Teacher Lessons')
@Controller('teacher/lessons')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherLessonsController {
  constructor(
    private readonly lessonsService: LessonsService,
    private readonly lessonAwsVideo: LessonAwsVideoService,
  ) {}

  /**
   * Get my lessons
   * Returns the authenticated teacher's lessons
   */
  @Get()
  @ApiOperation({
    summary: 'Get my lessons',
    description: "Returns a paginated list of the authenticated teacher's lessons. Teacher only.",
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
    @Query() filter: TeacherLessonFilterDto,
  ): Promise<unknown> {
    return await this.lessonsService.findMyLessons(user.userId, filter);
  }

  /**
   * Create a new lesson
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new lesson',
    description: 'Creates a lesson owned by the authenticated teacher.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Lesson created successfully',
  })
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
  @Get(':id')
  @ApiOperation({
    summary: 'Get one of my lessons',
    description: 'Returns a single lesson by ID for the authenticated teacher.',
  })
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
      throw new ForbiddenException('You can only view your own lessons');
    }
    return lesson;
  }

  /**
   * Update a lesson
   */
  @Put(':id')
  @ApiOperation({
    summary: 'Update one of my lessons',
    description: 'Updates a lesson owned by the authenticated teacher.',
  })
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

  @Post(':id/publish')
  @ApiOperation({ summary: 'Publish a ready lesson' })
  public async publish(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    const lesson = await this.lessonsService.publishLesson(id, user.userId);
    return { message: 'Lesson published successfully', lesson };
  }

  @Put(':id/visibility')
  @ApiOperation({ summary: 'Hide or return a lesson to draft' })
  public async setVisibility(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetLessonVisibilityDto,
  ): Promise<unknown> {
    const lesson = await this.lessonsService.setLessonVisibility(id, user.userId, dto.status);
    return { message: 'Lesson visibility updated successfully', lesson };
  }

  /**
   * Delete a lesson
   */
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete one of my lessons',
    description: 'Deletes a lesson owned by the authenticated teacher.',
  })
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

  /* ===================== AWS video: direct-to-S3 upload ===================== */

  /** Whether the AWS video pipeline is configured on this deployment (the UI hides uploads when it is not). */
  @Get('video/aws/capabilities')
  @ApiOperation({ summary: 'Is direct-to-S3 video upload available?' })
  public awsVideoCapabilities(): { enabled: boolean } {
    return { enabled: this.lessonAwsVideo.isEnabled() };
  }

  /** Presigned (or multipart) upload plan for the lesson's video; the browser uploads straight to S3. */
  @Post(':id/video/aws/upload')
  @ApiOperation({ summary: 'Start a direct-to-S3 video upload' })
  public async startAwsVideoUpload(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartAwsVideoUploadDto,
  ): Promise<unknown> {
    return await this.lessonAwsVideo.startUpload(id, user.userId, {
      filename: dto.filename,
      contentType: dto.content_type,
      size: dto.size,
    });
  }

  /** Verify the uploaded source, start transcoding and attach it to the lesson. */
  @Post(':id/video/aws/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finish a direct-to-S3 video upload and start processing' })
  public async completeAwsVideoUpload(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteAwsVideoUploadDto,
  ): Promise<unknown> {
    return await this.lessonAwsVideo.completeUpload(id, user.userId, dto.upload_id);
  }

  /** Processing state of the lesson's video; poll until `ready` or `failed`. */
  @Get(':id/video/status')
  @ApiOperation({ summary: 'Get the lesson video processing status' })
  public async getVideoStatus(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return await this.lessonsService.refreshVideoStatus(id, user.userId);
  }

  /** Delete the lesson's video (stored objects and metadata). */
  @Delete(':id/video')
  @ApiOperation({ summary: 'Delete the lesson video' })
  public async deleteVideo(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    await this.lessonsService.removeVideo(id, user.userId);
    return { message: 'Video removed successfully' };
  }
}
