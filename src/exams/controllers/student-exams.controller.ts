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
      description_ar: e.description_ar,
      subject: e.subject ? { id: e.subject.id, name: e.subject.name } : null,
      teacher: e.teacher ? { id: e.teacher.id, name: e.teacher.name } : null,
      total_marks: e.total_marks,
      passing_marks: e.passing_marks,
      duration_seconds: e.config.duration_seconds,
      attempts_allowed: e.config.attempts_allowed,
      start_window_at: e.config.start_window_at ?? null,
      end_window_at: e.config.end_window_at ?? null,
      status: e.status,
      is_public: e.is_public,
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

  @Get('question-bank')
  @ApiOperation({ summary: 'List public exams available to every student' })
  public async questionBank(@Query() filter: ExamFilterDto): Promise<PaginatedResponse<unknown>> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const qb = this.exams
      .createQueryBuilder('exam')
      .leftJoinAndSelect('exam.subject', 'subject')
      .leftJoinAndSelect('exam.teacher', 'teacher')
      .where('exam.deleted_at IS NULL')
      .andWhere('exam.is_public = true')
      .andWhere('exam.status IN (:...statuses)', {
        statuses: [ExamStatus.PUBLISHED, ExamStatus.SCHEDULED],
      });
    if (filter.subject_id) qb.andWhere('exam.subject_id = :s', { s: filter.subject_id });
    if (filter.search) {
      qb.andWhere('(exam.title ILIKE :q OR exam.title_ar ILIKE :q)', {
        q: `%${filter.search}%`,
      });
    }
    qb.orderBy('exam.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const data = rows.map((exam) => this.toListItem(exam));
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
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

  private toListItem(exam: Exam): Record<string, unknown> {
    return {
      id: exam.id,
      title: exam.title,
      title_ar: exam.title_ar,
      description: exam.description,
      description_ar: exam.description_ar,
      subject: exam.subject ? { id: exam.subject.id, name: exam.subject.name } : null,
      teacher: exam.teacher ? { id: exam.teacher.id, name: exam.teacher.name } : null,
      total_marks: exam.total_marks,
      passing_marks: exam.passing_marks,
      duration_seconds: exam.config.duration_seconds,
      attempts_allowed: exam.config.attempts_allowed,
      start_window_at: exam.config.start_window_at ?? null,
      end_window_at: exam.config.end_window_at ?? null,
      status: exam.status,
      is_public: exam.is_public,
    };
  }
}
