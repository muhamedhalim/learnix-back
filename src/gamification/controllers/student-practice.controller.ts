import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { InvalidatesCache } from '../../common/cache/cache-invalidation.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { GetNextQuestionQueryDto, StartSessionDto, SubmitAnswerDto } from '../dto/practice.dto';
import { GamificationService } from '../services/gamification.service';
import { PracticeService } from '../services/practice.service';

/**
 * Student-facing practice loop + own game profile. This is the addictive core:
 * fetch a question, submit an answer, get an instant graded result with XP /
 * rating / combo / streak deltas.
 */
@ApiTags('Gamification - Practice')
@Controller('student')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentPracticeController {
  constructor(
    private readonly practice: PracticeService,
    private readonly gamification: GamificationService,
  ) {}

  @Get('game/profile')
  @ApiOperation({ summary: "My game profile (XP, level, rating, streak, rank)" })
  public async myProfile(@GetUser() user: JwtPayload) {
    return this.gamification.getProfileSummary(user.userId);
  }

  @Get('practice/next')
  @ApiOperation({ summary: 'Next practice question (unsolved-first, shuffled)' })
  public async next(@GetUser() user: JwtPayload, @Query() query: GetNextQuestionQueryDto) {
    const question = await this.practice.getNext(user.userId, {
      subjectId: query.subject_id,
      difficulty: query.difficulty,
    });
    return { question };
  }

  @Post('practice/answer')
  // Writes `student_game_profiles`, `student_subject_ratings` and `question_solves`, which the public
  // profile and leaderboard (`gamification_public`) read. The whole family is invalidated, not one owner
  // slice: a solve changes other students' leaderboard ranks and `global_rank` (T037; this replaces the
  // temporary T030 exemption). `question_solves` also feeds the answering student's own `student_quiz_analytics`
  // performance insights (T040) — that slice is owner-scoped since only the answering student's evidence changes.
  @InvalidatesCache(['gamification_public', { family: 'student_quiz_analytics', scope: 'self' }])
  @ApiOperation({ summary: 'Submit an answer — grades + awards + returns result' })
  public async answer(@GetUser() user: JwtPayload, @Body() dto: SubmitAnswerDto) {
    return this.practice.submitAnswer(user.userId, {
      questionId: dto.question_id,
      response: dto.response ?? null,
      timeMs: dto.time_ms,
      sessionId: dto.session_id ?? null,
    });
  }

  @Post('practice/session')
  // `ensureProfile` may insert a game profile, which joins the public leaderboard (also invalidated
  // by the service itself on insert). The session row is read by no cached family (T037).
  @InvalidatesCache(['gamification_public'])
  @ApiOperation({ summary: 'Open a practice session' })
  public async startSession(@GetUser() user: JwtPayload, @Body() dto: StartSessionDto) {
    const session = await this.practice.startSession(user.userId, {
      subjectId: dto.subject_id,
      difficulty: dto.difficulty,
    });
    return { session_id: session.id };
  }

  @Post('practice/session/:id/end')
  @ApiOperation({ summary: 'Close a practice session' })
  public async endSession(@GetUser() user: JwtPayload, @Param('id') id: string) {
    await this.practice.endSession(user.userId, id);
    return { ended: true };
  }
}
