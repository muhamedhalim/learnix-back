import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { FILE_LIMITS } from '../../common/constants';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { biBody } from '../../i18n/error-translator.util';
import {
  CreateLessonDto,
  TeacherLessonFilterDto,
  UpdateLessonDto,
  UpdateLessonVideoDto,
  UpdateVimeoInfoDto,
  UpdateVimeoUrlDto,
} from '../dto';
import { LessonsService } from '../lessons.service';

/** Minimal shape of a multer in-memory file (mirrors teacher-uploads). */
interface MulterFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

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
  @ApiOperation({
    summary: 'Create a new lesson',
    description: 'Creates a lesson owned by the authenticated teacher.',
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
    return await this.lessonsService.updateVideoUrl(id, user.userId, dto.video_url, dto.duration);
  }

  /* ===================== Bunny Stream — backend-proxied upload ===================== */

  /**
   * Upload a lesson video. The browser sends the local file to THIS backend
   * (multipart), and the backend streams it on to Bunny Stream — the frontend
   * never talks to Bunny and the API key never leaves the server. Replaces any
   * existing video on the lesson.
   */
  @Post(':id/video')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: FILE_LIMITS.VIDEO_MAX_SIZE },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a lesson video (proxied to Bunny Stream)',
    description:
      'Accepts a local video file, forwards it to the Bunny Stream library, and stores only Bunny metadata. Replaces any existing video. The Bunny API key never reaches the client.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'No file provided or unsupported/oversized video',
  })
  public async uploadVideo(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file?: MulterFile,
  ): Promise<unknown> {
    if (!file) {
      throw new BadRequestException(biBody('No video file provided.', 'لم يتم توفير ملف فيديو.'));
    }
    if (!file.mimetype?.startsWith('video/')) {
      throw new BadRequestException(
        biBody(
          'Unsupported file type. Please upload a video file (MP4, MOV, WebM, …).',
          'نوع الملف غير مدعوم. يرجى رفع ملف فيديو (MP4، MOV، WebM، ...).',
        ),
      );
    }
    if (file.size > FILE_LIMITS.VIDEO_MAX_SIZE) {
      const maxGb = Math.round(FILE_LIMITS.VIDEO_MAX_SIZE / (1024 * 1024 * 1024));
      throw new BadRequestException(
        biBody(
          `Video is too large (max ${String(maxGb)} GB).`,
          `حجم الفيديو كبير جدًا (الحد الأقصى ${String(maxGb)} جيجابايت).`,
        ),
      );
    }
    return await this.lessonsService.uploadBunnyVideo(id, user.userId, file);
  }

  /**
   * Poll the encoding status of the lesson's Bunny video and persist the
   * latest metadata (duration, resolution, poster, size, status).
   */
  @Get(':id/video/status')
  @ApiOperation({
    summary: 'Get Bunny Stream video status',
    description:
      "Fetches and stores the lesson video's encoding status and metadata from Bunny Stream.",
  })
  public async getBunnyStatus(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return await this.lessonsService.refreshBunnyStatus(id, user.userId);
  }

  /**
   * Delete the lesson's Bunny Stream video and clear stored video metadata.
   */
  @Delete(':id/video/bunny')
  @ApiOperation({
    summary: 'Delete the Bunny Stream video',
    description:
      'Removes the video from Bunny Stream and clears the stored video metadata on the lesson.',
  })
  public async deleteBunnyVideo(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    await this.lessonsService.removeBunnyVideo(id, user.userId);
    return { message: 'Video removed successfully' };
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
    return await this.lessonsService.updateVideoUrl(id, user.userId, vimeoUrl, dto.duration);
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
    const lesson = await this.lessonsService.updateVimeoInfo(id, user.userId, vimeoDto);
    return {
      message: 'Vimeo info updated successfully',
      lesson,
    };
  }
}
