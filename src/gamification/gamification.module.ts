import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ExamsModule } from '../exams/exams.module';
import { Lesson } from '../lessons/entities/lesson.entity';
import { Question } from '../exams/entities';
import { NotificationsModule } from '../notifications/notifications.module';
import { QUEUE_CONFIGS, QUEUE_NAMES } from '../queues/queues.constants';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import {
  PracticeSession,
  QuestionSolve,
  RankTier,
  StudentGameProfile,
  StudentQuestionState,
  StudentSubjectRating,
  XpEvent,
} from './entities';
import { GamificationPublicController } from './controllers/gamification-public.controller';
import { StudentPracticeController } from './controllers/student-practice.controller';
import { GameSweepProcessor } from './processors/game-sweep.processor';
import { GameJobsService } from './services/game-jobs.service';
import { GameNotificationsService } from './services/game-notifications.service';
import { GamificationService } from './services/gamification.service';
import { LeaderboardService } from './services/leaderboard.service';
import { PracticeService } from './services/practice.service';
import { PublicProfileService } from './services/public-profile.service';
import { RankSeederService } from './services/rank-seeder.service';
import { RankService } from './services/rank.service';

/**
 * Gamification module — the competitive Question Bank layer: practice-solve
 * flow, XP + Elo rating, streaks/combos, visual ranks, and public leaderboards.
 * Built on the existing question bank + grading engine (imported via
 * `ExamsModule`, which exports `QuestionTypeRegistry` + the `Question` repo).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Owned tables
      RankTier,
      StudentGameProfile,
      StudentSubjectRating,
      StudentQuestionState,
      QuestionSolve,
      XpEvent,
      PracticeSession,
      // Read access to shared tables (repos; entities also registered elsewhere)
      Question,
      Subject,
      Lesson,
      User,
      StudentProfile,
    ]),
    // Provides QuestionTypeRegistry (grading) + GradingService.
    ExamsModule,
    // In-app gamification notifications (rank-up, streak milestones).
    NotificationsModule,
    // Gamification maintenance queue (streak-reset sweep).
    BullModule.registerQueue({
      name: QUEUE_NAMES.GAMIFICATION,
      ...QUEUE_CONFIGS[QUEUE_NAMES.GAMIFICATION],
    }),
  ],
  controllers: [StudentPracticeController, GamificationPublicController],
  providers: [
    RankSeederService,
    RankService,
    GamificationService,
    PracticeService,
    LeaderboardService,
    PublicProfileService,
    GameNotificationsService,
    GameJobsService,
    GameSweepProcessor,
  ],
  exports: [TypeOrmModule, GamificationService, RankService],
})
export class GamificationModule {}
