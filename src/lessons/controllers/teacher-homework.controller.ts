import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Response } from 'express';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import type { StoredObject } from '../../storage/storage.interface';
import { GradeHomeworkDto } from '../dto/homework.dto';
import {
  TeacherHomeworkAnalyticsDto,
  TeacherHomeworkFilterDto,
  TeacherHomeworkSubmissionFilterDto,
} from '../dto/teacher-homework.dto';
import { TeacherHomeworkService } from '../teacher-homework.service';

/** A central teacher-only workspace; lesson-scoped endpoints remain compatible. */
@ApiTags('Teacher Homework')
@Controller('teacher/homework')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherHomeworkController {
  constructor(private readonly homework: TeacherHomeworkService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Homework dashboard for the authenticated teacher' })
  public async dashboard(@GetUser() user: JwtPayload): Promise<{ data: Record<string, unknown> }> {
    return { data: await this.homework.dashboard(user.userId) };
  }

  @Get('analytics')
  @ApiOperation({ summary: 'Aggregate homework performance for the authenticated teacher' })
  public async analytics(
    @GetUser() user: JwtPayload,
    @Query() filter: TeacherHomeworkAnalyticsDto,
  ): Promise<{ data: Record<string, unknown> }> {
    return { data: await this.homework.analytics(user.userId, filter) };
  }

  @Get()
  @ApiOperation({ summary: 'List all homework owned by the authenticated teacher' })
  public async list(
    @GetUser() user: JwtPayload,
    @Query() filter: TeacherHomeworkFilterDto,
  ): Promise<Record<string, unknown>> {
    return await this.homework.list(user.userId, filter);
  }

  @Get(':homeworkId')
  @ApiOperation({ summary: 'Get an owned homework summary' })
  public async detail(
    @GetUser() user: JwtPayload,
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
  ): Promise<{ data: Record<string, unknown> }> {
    return { data: await this.homework.detail(user.userId, homeworkId) };
  }

  @Get(':homeworkId/resource')
  @ApiOperation({ summary: 'Download an owned private homework resource' })
  public async homeworkResource(
    @GetUser() user: JwtPayload,
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.homework.getHomeworkResource(user.userId, homeworkId);
    this.streamPrivate(res, file.object, file.filename);
  }

  @Get(':homeworkId/submissions')
  @ApiOperation({ summary: 'List the actual assignment audience and their submission state' })
  public async submissions(
    @GetUser() user: JwtPayload,
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
    @Query() filter: TeacherHomeworkSubmissionFilterDto,
  ): Promise<Record<string, unknown>> {
    return await this.homework.listSubmissions(user.userId, homeworkId, filter);
  }

  @Get(':homeworkId/submissions/:submissionId')
  @ApiOperation({ summary: 'Open a submitted homework response for grading' })
  public async submissionDetail(
    @GetUser() user: JwtPayload,
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
  ): Promise<{ data: Record<string, unknown> }> {
    return { data: await this.homework.submissionDetail(user.userId, homeworkId, submissionId) };
  }

  @Get(':homeworkId/submissions/:submissionId/file')
  @ApiOperation({ summary: 'Download an owned private student submission file' })
  public async submissionFile(
    @GetUser() user: JwtPayload,
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.homework.getSubmissionFile(user.userId, homeworkId, submissionId);
    this.streamPrivate(res, file.object, file.filename);
  }

  @Patch(':homeworkId/submissions/:submissionId/grade')
  @ApiOperation({ summary: 'Grade an owned homework submission' })
  public async grade(
    @GetUser() user: JwtPayload,
    @Param('homeworkId', ParseUUIDPipe) homeworkId: string,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: GradeHomeworkDto,
  ): Promise<{ message: string; data: Record<string, unknown> }> {
    return {
      message: 'Homework graded',
      data: await this.homework.grade(user.userId, homeworkId, submissionId, dto),
    };
  }

  private streamPrivate(res: Response, object: StoredObject, filename: string): void {
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Content-Disposition', this.contentDisposition(filename));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (object.contentLength !== undefined)
      res.setHeader('Content-Length', object.contentLength.toString());
    object.stream.on('error', () => res.destroy());
    object.stream.pipe(res);
  }

  private safeFilename(value: string): string {
    return value.replaceAll(/[\\/\r\n"]/gu, '_').slice(0, 255) || 'download';
  }

  private contentDisposition(filename: string): string {
    const safeName = this.safeFilename(filename);
    // `filename*` preserves Arabic and other Unicode names. The ASCII fallback
    // keeps Node's HTTP header writer and older browsers safe.
    const asciiFallback = safeName.replaceAll(/[^\x20-\x7E]/gu, '_');
    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
  }
}
