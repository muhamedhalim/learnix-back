import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { PaginatedResponse, PaginationMeta } from '../../common/interfaces/pagination.interface';
import { ExamFilterDto, SaveAnswersDto, SubmitAttemptDto } from '../dto';
import { Exam, ExamStatus } from '../entities';
import { AttemptService } from '../services/attempt.service';
import { ExamAccessService } from '../services/exam-access.service';

/**
 * Student-facing exam endpoints: browse available exams, start/resume an
 * attempt, autosave answers, submit, and view results. All attempt logic lives
 * in {@link AttemptService}; this controller stays thin.
 */
@ApiTags('Student · Exams')
@Controller('student/exams')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentExamsController {
  constructor(
    private readonly attempts: AttemptService,
    private readonly access: ExamAccessService,
    @InjectRepository(Exam) private readonly exams: Repository<Exam>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List published exams available to take' })
  public async list(
    @GetUser() user: JwtPayload,
    @Query() filter: ExamFilterDto,
  ): Promise<PaginatedResponse<unknown>> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const qb = this.exams
      .createQueryBuilder('exam')
      .leftJoinAndSelect('exam.subject', 'subject')
      .leftJoinAndSelect('exam.teacher', 'teacher')
      .where('exam.deleted_at IS NULL')
      .andWhere('exam.status IN (:...statuses)', {
        statuses: [ExamStatus.PUBLISHED, ExamStatus.SCHEDULED],
      });
    this.access.applyStudentScope(qb, user.userId);
    if (filter.subject_id) qb.andWhere('exam.subject_id = :s', { s: filter.subject_id });
    if (filter.search)
      qb.andWhere('(exam.title ILIKE :q OR exam.title_ar ILIKE :q)', { q: `%${filter.search}%` });
    qb.orderBy('exam.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const data = rows.map((e) => ({
      id: e.id,
      title: e.title,
      title_ar: e.title_ar,
      description: e.description,
      subject: e.subject ? { id: e.subject.id, name: e.subject.name } : null,
      teacher: e.teacher ? { id: e.teacher.id, name: e.teacher.name } : null,
      total_marks: e.total_marks,
      passing_marks: e.passing_marks,
      duration_seconds: e.config.duration_seconds,
      attempts_allowed: e.config.attempts_allowed,
      status: e.status,
    }));
    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
    return { data, meta };
  }

  @Post(':id/start')
  @ApiOperation({ summary: 'Start (or resume) an attempt' })
  public start(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) examId: string) {
    return this.attempts.startAttempt(user.userId, examId);
  }

  @Get('attempts/:attemptId')
  @ApiOperation({ summary: 'Resume an attempt (restores saved answers + timer)' })
  public getAttempt(
    @GetUser() user: JwtPayload,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
  ) {
    return this.attempts.getAttempt(user.userId, attemptId);
  }

  @Patch('attempts/:attemptId/answers')
  @ApiOperation({ summary: 'Autosave answers' })
  public save(
    @GetUser() user: JwtPayload,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Body() dto: SaveAnswersDto,
  ) {
    return this.attempts.saveAnswers(user.userId, attemptId, dto);
  }

  @Post('attempts/:attemptId/submit')
  @ApiOperation({ summary: 'Submit an attempt (idempotent)' })
  public submit(
    @GetUser() user: JwtPayload,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Body() dto: SubmitAttemptDto,
  ) {
    return this.attempts.submit(user.userId, attemptId, dto);
  }

  @Get(':id/result')
  @ApiOperation({ summary: 'Get the result for the latest attempt at an exam' })
  public result(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) examId: string) {
    return this.attempts.getResult(user.userId, examId);
  }
}
