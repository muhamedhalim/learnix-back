import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Response } from 'express';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { FILE_LIMITS } from '../../common/constants';
import { Pagination20Dto } from '../../common/dto/pagination.dto';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { UploadService } from '../../uploads/upload.service';
import { SubmitHomeworkDto } from '../dto';
import { LessonContentService } from '../lesson-content.service';

@ApiTags('Student Homework')
@Controller('student/homework')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentHomeworkController {
  constructor(
    private readonly content: LessonContentService,
    private readonly uploads: UploadService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List published homework for the student's enrolled lessons" })
  public async list(
    @GetUser() user: JwtPayload,
    @Query() pagination: Pagination20Dto,
  ): Promise<unknown> {
    return await this.content.listStudentHomework(
      user.userId,
      pagination.page,
      pagination.limit,
    );
  }

  @Get(':homeworkId/resource')
  @ApiOperation({ summary: 'Download an enrolled homework resource' })
  public async resource(
    @GetUser() user: JwtPayload,
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
    @Res() res: Response,
  ): Promise<void> {
    const object = await this.content.getHomeworkResourceForStudent(user.userId, homeworkId);
    this.streamPrivate(res, object);
  }

  @Get(':homeworkId/submission/file')
  @ApiOperation({ summary: 'Download my homework submission file' })
  public async submissionFile(
    @GetUser() user: JwtPayload,
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
    @Res() res: Response,
  ): Promise<void> {
    const object = await this.content.getSubmissionFileForStudent(user.userId, homeworkId);
    this.streamPrivate(res, object);
  }

  @Post(':homeworkId/submit')
  @ApiOperation({ summary: 'Submit or replace an ungraded homework response' })
  public async submit(
    @GetUser() user: JwtPayload,
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
    @Body() dto: SubmitHomeworkDto,
  ): Promise<{ message: string; data: unknown }> {
    const data = await this.content.submitHomework(user.userId, homeworkId, dto);
    return { message: 'Homework submitted', data };
  }

  @Post(':homeworkId/upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: FILE_LIMITS.RESOURCE_MAX_SIZE, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a homework response file' })
  public async upload(
    @GetUser() user: JwtPayload,
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ url: string; filename: string }> {
    await this.content.assertStudentCanAccessHomework(user.userId, homeworkId);
    if (!file) {
      // UploadService expects a file; keeping the controller check gives a
      // deterministic client error before any storage call.
      throw new BadRequestException('No file provided');
    }
    return this.uploads.uploadPrivateHomeworkSubmission(file, user.userId);
  }

  private streamPrivate(
    res: Response,
    object: Awaited<ReturnType<LessonContentService['getHomeworkResourceForStudent']>>,
  ): void {
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', object.contentLength.toString());
    }
    object.stream.on('error', () => res.destroy());
    object.stream.pipe(res);
  }
}
