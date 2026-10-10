import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { Response } from 'express';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Pagination20Dto } from '../../common/dto/pagination.dto';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { LessonFilterDto, UpsertNoteDto } from '../dto';
import { LessonContentService } from '../lesson-content.service';
import { LessonsService } from '../lessons.service';
import { PlaybackCookiesInterceptor } from '../../video/playback-cookies';

@ApiTags('Lessons')
@Controller('lessons')
export class LessonsController {
  constructor(
    private readonly lessonsService: LessonsService,
    private readonly lessonContentService: LessonContentService,
  ) {}

  /**
   * Attachments for a lesson, gated by the same viewer policy as playback
   * (owning teacher / admin / enrolled student).
   */
  @Get(':id/attachments')
  @UseGuards(HybridAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'List lesson attachments (viewer)',
    description:
      'Returns downloadable resources for a lesson. Restricted to the owning teacher, admins, or enrolled students.',
  })
  public async getAttachments(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    await this.lessonsService.assertViewerAccess(id, user.userId, user.role);
    return await this.lessonContentService.getAttachmentsForLesson(id);
  }

  @Get(':id/attachments/:attachmentId/download')
  @UseGuards(HybridAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Download an authorized private lesson attachment' })
  public async downloadAttachment(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.lessonsService.assertViewerAccess(id, user.userId, user.role);
    const { attachment, object } = await this.lessonContentService.getAttachmentObject(
      id,
      attachmentId,
    );
    const safeName = attachment.name.replace(/[\r\n"\\/]+/g, '_') || 'attachment';
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', object.contentLength.toString());
    }
    object.stream.on('error', () => res.destroy());
    object.stream.pipe(res);
  }

  /**
   * The caller's private note for a lesson (null when none saved yet).
   */
  @Get(':id/note')
  @UseGuards(HybridAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Get my note for a lesson',
    description:
      "Returns the caller's private study note for this lesson, or null.",
  })
  public async getNote(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    await this.lessonsService.assertViewerAccess(id, user.userId, user.role);
    const note = await this.lessonContentService.getNote(user.userId, id);
    return { data: note };
  }

  /**
   * Create or update the caller's private note for a lesson.
   */
  @Put(':id/note')
  @UseGuards(HybridAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Save my note for a lesson',
    description: "Upserts the caller's private study note for this lesson.",
  })
  public async saveNote(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertNoteDto,
  ): Promise<unknown> {
    await this.lessonsService.assertViewerAccess(id, user.userId, user.role);
    const note = await this.lessonContentService.upsertNote(
      user.userId,
      id,
      dto.content,
    );
    return { data: note };
  }

  @Get(':id/signed-url')
  @UseGuards(HybridAuthGuard)
  @UseInterceptors(PlaybackCookiesInterceptor)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Get a signed playback URL for a lesson video',
    description:
      'Returns a short-lived Bunny Stream token-signed URL. Restricted to the owning teacher, admins, or enrolled students.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Signed playback URL' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not enrolled in this course',
  })
  public async getSignedUrl(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ signedUrl: string; expiresIn: number; platform?: 'aws' }> {
    return await this.lessonsService.getSignedPlaybackUrl(
      id,
      user.userId,
      user.role,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'Get all lessons',
    description:
      'Returns a paginated list of lessons. Supports search by title, filtering by teacher/subject/price, sorting by price/title/date/popularity.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by lesson title',
  })
  @ApiQuery({
    name: 'teacher_id',
    required: false,
    type: Number,
    description: 'Filter by teacher ID',
  })
  @ApiQuery({
    name: 'subject_id',
    required: false,
    type: Number,
    description: 'Filter by subject ID',
  })
  @ApiQuery({
    name: 'is_group',
    required: false,
    type: Boolean,
    description: 'Filter by group lessons',
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
    description: 'Items per page (default: 20, max: 100)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of lessons with pagination meta',
  })
  public async findAll(@Query() filter: LessonFilterDto): Promise<unknown> {
    return await this.lessonsService.findAllPublic(filter);
  }

  /**
   * Get a single lesson by ID
   */
  @Get(':id')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return await this.lessonsService.findOnePublic(id);
  }

  /**
   * Get lessons by teacher
   */
  @Get('teacher/:teacherId')
  @ApiOperation({
    summary: 'Get lessons by teacher',
    description: 'Returns all lessons created by a specific teacher.',
  })
  @ApiParam({ name: 'teacherId', description: 'Teacher user ID' })
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
    description: 'List of lessons by teacher',
  })
  public async findByTeacher(
    @Param('teacherId', ParseUUIDPipe) teacherId: string,
    @Query() pagination: Pagination20Dto,
  ): Promise<unknown> {
    return await this.lessonsService.findByTeacherPublic(teacherId, {
      page: pagination.page,
      limit: pagination.limit,
    });
  }

  /**
   * Get lessons by subject
   */
  @Get('subject/:subjectId')
  @ApiOperation({
    summary: 'Get lessons by subject',
    description: 'Returns all lessons for a specific subject.',
  })
  @ApiParam({ name: 'subjectId', description: 'Subject ID' })
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
    description: 'List of lessons by subject',
  })
  public async findBySubject(
    @Param('subjectId', ParseUUIDPipe) subjectId: string,
    @Query() pagination: Pagination20Dto,
  ): Promise<unknown> {
    return await this.lessonsService.findBySubjectPublic(subjectId, {
      page: pagination.page,
      limit: pagination.limit,
    });
  }
}
