import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { InvalidatesCache } from '../../common/cache/cache-invalidation.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Pagination20Dto } from '../../common/dto/pagination.dto';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { GradeAnswerDto } from '../dto';
import { TeacherGradingService } from '../services/teacher-grading.service';

/** Teacher grading endpoints (submissions, attempt inspection, manual grading). */
@ApiTags('Teacher · Grading')
@Controller('teacher/exams')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherGradingController {
  constructor(private readonly grading: TeacherGradingService) {}

  @Get(':id/submissions')
  @ApiOperation({ summary: 'List submissions for an exam' })
  public submissions(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
    @Query() pagination: Pagination20Dto,
  ) {
    return this.grading.getSubmissions(
      examId,
      user.userId,
      pagination.page,
      pagination.limit,
    );
  }

  @Get(':id/attempts/:attemptId')
  @ApiOperation({ summary: 'Inspect a single submission for grading' })
  public attempt(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
  ) {
    return this.grading.getAttemptDetail(examId, attemptId, user.userId);
  }

  @Post(':id/answers/:answerId/grade')
  // Writes `exam_attempt_answers` (manual score) and `exam_attempts` (recomputed totals, GRADING -> GRADED). Read by
  // exam_analytics, student_dashboard, student_profile, student_report and teacher_report; no attempt is created, so
  // admin_dashboard/platform_report are unaffected. Analytics recompute and parent notifications are queue-driven (T032).
  // T035: the grader IS the exam's owning teacher (`assertExamOwner` requires `exam.teacher_id = principal`), so the
  // teacher-side slices are `self`. The graded student is a different owner: `TeacherGradingService.gradeAnswer`
  // invalidates that student's slice after the commit.
  @InvalidatesCache([
    { family: 'teacher_report', scope: 'self' },
    { family: 'exam_analytics', scope: 'self' },
    { family: 'teacher_quiz_analytics', scope: 'self' },
  ])
  @ApiOperation({ summary: 'Grade a manual (essay) answer' })
  public grade(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) examId: string,
    @Param('answerId', ParseUUIDPipe) answerId: string,
    @Body() dto: GradeAnswerDto,
  ) {
    return this.grading.gradeAnswer(examId, answerId, user.userId, dto);
  }
}
