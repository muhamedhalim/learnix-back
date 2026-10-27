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

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import {
  InvalidatesCache,
  SkipCacheInvalidation,
} from '../../common/cache/cache-invalidation.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { PaginatedResponse } from '../../common/interfaces/pagination.interface';
import { ExamFilterDto, SaveAnswersDto, SubmitAttemptDto } from '../dto';
import { AttemptService } from '../services/attempt.service';
import { StudentExamCatalogService } from '../services/student-exam-catalog.service';

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
    private readonly catalog: StudentExamCatalogService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List published exams available to take' })
  public async list(
    @GetUser() user: JwtPayload,
    @Query() filter: ExamFilterDto,
  ): Promise<PaginatedResponse<unknown>> {
    return await this.catalog.listForStudent(user.userId, filter);
  }

  @Get('question-bank')
  @ApiOperation({ summary: 'List public exams available to every student' })
  public async questionBank(@Query() filter: ExamFilterDto): Promise<PaginatedResponse<unknown>> {
    return await this.catalog.listQuestionBank(filter);
  }

  @Post(':id/start')
  // Inserts an `exam_attempts` row plus its `exam_attempt_answers` and schedules the auto-submit job. The resume
  // branch can also finalize an expired attempt (grades, state, score), so the set is the union of start and submit:
  // exam_attempts is read by exam_analytics, student_dashboard, student_profile, student_report, teacher_report
  // (attempt rows, counts, scores) and, via created_at counts, admin_dashboard and platform_report (T032).
  // T035: the student's own slice is `self` (the principal is the student taking the exam). The exam owner's
  // slice (teacher_report, exam_analytics) is a different owner, so `AttemptService` invalidates it after the
  // commit; admin_dashboard and platform_report are role-scoped and stay family-level.
  @InvalidatesCache([
    { family: 'student_dashboard', scope: 'self' },
    { family: 'student_profile', scope: 'self' },
    { family: 'student_report', scope: 'self' },
    'admin_dashboard',
    'platform_report',
  ])
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
  // Writes only `exam_attempt_answers` of IN_PROGRESS attempts; exam analytics
  // reads answers for GRADED attempts only (analytics.service.ts, `attempt.state = $2`) (T030).
  @SkipCacheInvalidation()
  @ApiOperation({ summary: 'Autosave answers' })
  public save(
    @GetUser() user: JwtPayload,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Body() dto: SaveAnswersDto,
  ) {
    return this.attempts.saveAnswers(user.userId, attemptId, dto);
  }

  @Post('attempts/:attemptId/submit')
  // Finalization writes `exam_attempts` (state, scores, submitted_at, graded_at, passed) and `exam_attempt_answers`
  // (objective grades). It creates no attempt, so admin_dashboard (which counts attempts by created_at) is not needed;
  // platform_report is kept per the T032 plan. Analytics recompute, AI grading and parent notifications run in
  // BullMQ workers (non-HTTP writers, unchanged) (T032).
  // T035: student slice is `self`; the exam owner's slice is invalidated by `AttemptService.finalize` after the
  // commit (that funnel also serves auto-submit and the expiry sweep); platform_report stays family-level.
  @InvalidatesCache([
    { family: 'student_dashboard', scope: 'self' },
    { family: 'student_profile', scope: 'self' },
    { family: 'student_report', scope: 'self' },
    'platform_report',
  ])
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
