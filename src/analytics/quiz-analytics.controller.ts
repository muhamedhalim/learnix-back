import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { GetUser } from '../common/decorators/get-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { QuizAnalyticsService } from './quiz-analytics.service';

@ApiTags('Analytics · Quiz')
@Controller('analytics/quiz')
@UseGuards(HybridAuthGuard, RolesGuard)
@ApiBearerAuth('JWT-auth')
export class QuizAnalyticsController {
  constructor(private readonly quizAnalyticsService: QuizAnalyticsService) {}

  @Get('student')
  @Roles('student')
  @ApiOperation({ summary: 'My quiz performance analytics (student)' })
  public async student(
    @GetUser() user: JwtPayload,
    @Query('subject_id') subjectId?: string,
    @Query('teacher_id') teacherId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{ data: unknown }> {
    const data = await this.quizAnalyticsService.getStudentAnalytics(user.userId, {
      ...(subjectId ? { subjectId } : {}),
      ...(teacherId ? { teacherId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
    return { data };
  }

  @Get('teacher')
  @Roles('teacher')
  @ApiOperation({ summary: 'Quiz analytics across the teacher\'s exams' })
  public async teacher(@GetUser() user: JwtPayload): Promise<{ data: unknown }> {
    const data = await this.quizAnalyticsService.getTeacherAnalytics(user.userId);
    return { data };
  }

  @Get('teacher/exams/:examId')
  @Roles('teacher')
  @ApiOperation({ summary: 'Per-question difficulty + discrimination for one exam' })
  public async examQuestions(
    @GetUser() user: JwtPayload,
    @Param('examId', ParseUUIDPipe) examId: string,
  ): Promise<{ data: unknown }> {
    const data = await this.quizAnalyticsService.getExamQuestionAnalytics(
      examId,
      user.userId,
    );
    return { data };
  }

}
