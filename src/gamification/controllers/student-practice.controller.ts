import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
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
