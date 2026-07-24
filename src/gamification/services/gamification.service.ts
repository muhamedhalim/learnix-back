import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, Repository } from 'typeorm';

import { Difficulty } from '../../exams/entities/difficulty.enum';
import type { QuestionResponsePayload } from '../../exams/entities/content.types';
import {
  MIN_SOLVE_TIME_MS,
  QUESTION_RATING_BY_DIFFICULTY,
  STARTING_RATING,
  STREAK_DAILY_BONUS,
} from '../gamification.constants';
import {
  PracticeSession,
  QuestionSolve,
  StudentGameProfile,
  StudentQuestionState,
  StudentSubjectRating,
  XpEvent,
  XpReason,
} from '../entities';
import { ratingDelta } from '../logic/elo';
import { levelForXp, levelProgress } from '../logic/leveling';
import { appDateString, nextStreak, previousDay } from '../logic/streak';
import { baseXpForDifficulty, comboBonusFor, streakMilestoneBonusFor } from '../logic/xp-rules';
import { RankService } from './rank.service';

/** Everything the caller (practice flow) knows about one solve event. */
export interface SolveInput {
  userId: string;
  questionId: string;
  questionVersion: number;
  subjectId: string;
  lessonId: string | null;
  difficulty: Difficulty;
  isCorrect: boolean;
  response: QuestionResponsePayload | null;
  timeMs: number;
  sessionId?: string | null;
}

export interface XpBreakdownItem {
  reason: XpReason;
  amount: number;
}

/** Rich result the practice controller turns into the post-answer experience. */
export interface SolveResult {
  isCorrect: boolean;
  /** First correct solve of this question — the XP/rating-earning event. */
  firstSolve: boolean;
  /** First time this student ever attempted this question (right OR wrong). */
  firstAttempt: boolean;
  suspicious: boolean;
  xpAwarded: number;
  xpBreakdown: XpBreakdownItem[];
  ratingDelta: number;
  subjectRating: number;
  globalRating: number;
  combo: number;
  streak: number;
  streakExtendedToday: boolean;
  level: number;
  levelUp: boolean;
  xp: number;
  rankTierId: string | null;
  rankUp: boolean;
  /** True when this request returned the student's existing final answer. */
  alreadyAnswered: boolean;
  submittedAt: Date;
  response: QuestionResponsePayload | null;
}

/**
 * The heart of the gamification economy. `recordSolve` applies XP, Elo rating,
 * streak, and combo for a single practice solve inside ONE transaction so the
 * cached game profile, per-subject rating, solved-set, and append-only ledgers
 * can never drift. All the maths lives in the pure `logic/*` helpers; this
 * service is the stateful, transactional orchestrator.
 */
@Injectable()
export class GamificationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rankService: RankService,
    @InjectRepository(StudentGameProfile)
    private readonly profiles: Repository<StudentGameProfile>,
    @InjectRepository(QuestionSolve)
    private readonly solves: Repository<QuestionSolve>,
  ) {}

  /** The authenticated student's own game summary (profile + level progress + tier). */
  public async getProfileSummary(userId: string): Promise<{
    profile: StudentGameProfile;
    level: ReturnType<typeof levelProgress>;
    accuracy: number;
    rank_tier: import('../entities').RankTier | null;
  }> {
    const profile = await this.ensureProfile(userId);
    const tier = await this.rankService.resolveTier(profile.global_rating, profile.xp);
    const accuracy =
      profile.total_solved > 0
        ? Math.round((profile.total_correct / profile.total_solved) * 1000) / 10
        : 0;
    return { profile, level: levelProgress(profile.xp), accuracy, rank_tier: tier };
  }

  /**
   * Zero out streaks for students who missed a day, so leaderboards/profiles
   * don't show a stale streak until the student next solves. A student is still
   * "current" if their last active day is today or yesterday; anything older is
   * a broken streak. Idempotent — safe to run repeatedly. Returns rows reset.
   */
  public async sweepLapsedStreaks(): Promise<number> {
    const today = appDateString(new Date());
    const yesterday = previousDay(today);
    const result = await this.profiles
      .createQueryBuilder()
      .update(StudentGameProfile)
      .set({ current_streak: 0 })
      .where('current_streak > 0')
      .andWhere('(last_active_date IS NULL OR last_active_date < :yesterday)', { yesterday })
      .execute();
    return result.affected ?? 0;
  }

  /** Ensure a game profile exists for a student (idempotent). */
  public async ensureProfile(userId: string): Promise<StudentGameProfile> {
    const existing = await this.profiles.findOne({ where: { user_id: userId } });
    if (existing) return existing;
    // Explicit values for every transformer-backed numeric column: the shared
    // numericTransformer maps `undefined` → `null`, which would otherwise send
    // an explicit NULL into these NOT NULL columns instead of using the default.
    const created = this.profiles.create({
      user_id: userId,
      xp: 0,
      global_rating: STARTING_RATING,
      total_time_ms: 0,
    });
    try {
      return await this.profiles.save(created);
    } catch {
      // Concurrent create — the unique(user_id) guard won; re-read.
      const row = await this.profiles.findOne({ where: { user_id: userId } });
      if (!row) throw new Error('Failed to create game profile');
      return row;
    }
  }

  public async recordSolve(input: SolveInput): Promise<SolveResult> {
    await this.ensureProfile(input.userId);
    const rankLadderTierFor = (rating: number, xp: number) =>
      this.rankService.resolveTier(rating, xp);

    return this.dataSource.transaction(async (manager) => {
      const profileRepo = manager.getRepository(StudentGameProfile);
      const stateRepo = manager.getRepository(StudentQuestionState);
      const ratingRepo = manager.getRepository(StudentSubjectRating);
      const solveRepo = manager.getRepository(QuestionSolve);
      const xpRepo = manager.getRepository(XpEvent);
      const sessionRepo = manager.getRepository(PracticeSession);

      // Lock the profile row so concurrent solves for the same student serialize.
      const profile = await profileRepo.findOneOrFail({
        where: { user_id: input.userId },
        lock: { mode: 'pessimistic_write' },
      });

      // The profile lock serializes simultaneous submissions by one student.
      // The unique ledger constraint remains the final cross-process guard.
      const existing = await solveRepo.findOne({
        where: { user_id: input.userId, question_id: input.questionId },
      });
      if (existing) {
        const existingSubjectRating = await ratingRepo.findOne({
          where: { user_id: input.userId, subject_id: existing.subject_id },
        });
        return this.existingSolveResult(profile, existingSubjectRating, existing);
      }

      const state =
        (await stateRepo.findOne({
          where: { user_id: input.userId, question_id: input.questionId },
        })) ??
        stateRepo.create({
          user_id: input.userId,
          question_id: input.questionId,
          times_seen: 0,
          times_correct: 0,
          xp_earned: false,
          rating_applied: false,
        });

      const subjectRating =
        (await ratingRepo.findOne({
          where: { user_id: input.userId, subject_id: input.subjectId },
        })) ??
        ratingRepo.create({
          user_id: input.userId,
          subject_id: input.subjectId,
          rating: STARTING_RATING,
          solved: 0,
          correct: 0,
        });

      const now = new Date();
      const today = appDateString(now);
      const suspicious = input.timeMs < MIN_SOLVE_TIME_MS;
      const legit = input.isCorrect && !suspicious;
      // The one-row solve ledger makes this the first and only final answer.
      const firstAttempt = true;

      // --- solved-set bookkeeping ---
      state.times_seen += 1;
      if (input.isCorrect) {
        state.times_correct += 1;
        if (state.best_time_ms === null || input.timeMs < state.best_time_ms) {
          state.best_time_ms = input.timeMs;
        }
        if (state.first_correct_at === null) state.first_correct_at = now;
      }
      const firstSolve = firstAttempt && input.isCorrect;

      // --- XP ---
      const breakdown: XpBreakdownItem[] = [];
      if (firstAttempt && legit) {
        breakdown.push({ reason: XpReason.CORRECT_ANSWER, amount: baseXpForDifficulty(input.difficulty) });
        state.xp_earned = true;
      }

      // --- combo --- (count builds on any legit correct; BONUS xp only on a
      // first-attempt question so re-solving known questions can't farm it)
      const newCombo = legit ? profile.current_combo + 1 : 0;
      profile.current_combo = newCombo;
      if (newCombo > profile.longest_combo) profile.longest_combo = newCombo;
      const comboBonus = legit && firstAttempt ? comboBonusFor(newCombo) : 0;
      if (comboBonus > 0) breakdown.push({ reason: XpReason.COMBO_BONUS, amount: comboBonus });

      // --- streak (advances on the first legit correct solve of a new day) ---
      let streakExtendedToday = false;
      if (legit) {
        const ns = nextStreak(profile.current_streak, profile.last_active_date, today);
        if (ns.transition !== 'same_day') {
          profile.current_streak = ns.streak;
          profile.last_active_date = today;
          if (ns.streak > profile.longest_streak) profile.longest_streak = ns.streak;
          streakExtendedToday = true;
          breakdown.push({ reason: XpReason.STREAK_DAILY, amount: STREAK_DAILY_BONUS });
          const milestone = streakMilestoneBonusFor(ns.streak);
          if (milestone > 0) breakdown.push({ reason: XpReason.STREAK_MILESTONE, amount: milestone });
        }
      }

      // --- rating (Elo) — only the FIRST attempt of a question moves rating ---
      let delta = 0;
      if (firstAttempt && !suspicious) {
        const questionRating = QUESTION_RATING_BY_DIFFICULTY[input.difficulty];
        delta = ratingDelta({
          studentRating: subjectRating.rating,
          questionRating,
          isCorrect: input.isCorrect,
          timeMs: input.timeMs,
          solvedCount: subjectRating.solved,
        });
        subjectRating.rating = Math.round((subjectRating.rating + delta) * 100) / 100;
        subjectRating.solved += 1;
        if (input.isCorrect) subjectRating.correct += 1;
        state.rating_applied = true;
      }

      // --- persist state + subject rating, then recompute global rating ---
      await stateRepo.save(state);
      await ratingRepo.save(subjectRating);

      if (delta !== 0) {
        // Global rating = solved-weighted average across the student's subjects.
        const rows = await ratingRepo.find({ where: { user_id: input.userId } });
        const totalSolved = rows.reduce((s, r) => s + r.solved, 0);
        profile.global_rating =
          totalSolved > 0
            ? Math.round((rows.reduce((s, r) => s + r.rating * r.solved, 0) / totalSolved) * 100) / 100
            : subjectRating.rating;
      }

      // --- profile totals + level + rank ---
      const totalXp = breakdown.reduce((s, b) => s + b.amount, 0);
      const previousLevel = profile.level;
      const previousTierId = profile.rank_tier_id;
      profile.total_solved += 1;
      if (input.isCorrect) profile.total_correct += 1;
      else profile.total_wrong += 1;
      profile.total_time_ms += input.timeMs;
      profile.xp += totalXp;
      profile.level = levelForXp(profile.xp);
      const tier = await rankLadderTierFor(profile.global_rating, profile.xp);
      profile.rank_tier_id = tier ? tier.id : null;
      await profileRepo.save(profile);

      // --- append-only ledgers ---
      for (const item of breakdown) {
        await xpRepo.save(
          xpRepo.create({
            user_id: input.userId,
            amount: item.amount,
            reason: item.reason,
            ref_id: input.questionId,
            occurred_at: now,
          }),
        );
      }
      await solveRepo.save(
        solveRepo.create({
          user_id: input.userId,
          question_id: input.questionId,
          question_version: input.questionVersion,
          subject_id: input.subjectId,
          lesson_id: input.lessonId,
          difficulty: input.difficulty,
          response: input.response,
          is_correct: input.isCorrect,
          time_ms: input.timeMs,
          xp_awarded: totalXp,
          rating_delta: delta,
          combo_at_time: newCombo,
          first_solve: firstSolve,
          suspicious,
          session_id: input.sessionId ?? null,
        }),
      );

      // --- practice session counters ---
      if (input.sessionId) {
        const session = await sessionRepo.findOne({ where: { id: input.sessionId } });
        if (session) {
          session.answered_count += 1;
          if (input.isCorrect) session.correct_count += 1;
          if (newCombo > session.combo_peak) session.combo_peak = newCombo;
          await sessionRepo.save(session);
        }
      }

      const rankUp = tier !== null && tier.id !== previousTierId && previousTierId !== null;

      return {
        isCorrect: input.isCorrect,
        firstSolve,
        firstAttempt,
        suspicious,
        xpAwarded: totalXp,
        xpBreakdown: breakdown,
        ratingDelta: delta,
        subjectRating: subjectRating.rating,
        globalRating: profile.global_rating,
        combo: profile.current_combo,
        streak: profile.current_streak,
        streakExtendedToday,
        level: profile.level,
        levelUp: profile.level > previousLevel,
        xp: profile.xp,
        rankTierId: profile.rank_tier_id,
        rankUp,
        alreadyAnswered: false,
        submittedAt: now,
        response: input.response,
      };
    });
  }

  /** Read the prior final answer for the practice review screen. */
  public async existingSolveResultFor(
    userId: string,
    questionId: string,
  ): Promise<SolveResult | null> {
    const existing = await this.solves.findOne({
      where: { user_id: userId, question_id: questionId },
    });
    if (!existing) return null;

    const profile = await this.ensureProfile(userId);
    const subjectRating = await this.dataSource.getRepository(StudentSubjectRating).findOne({
      where: { user_id: userId, subject_id: existing.subject_id },
    });
    return this.existingSolveResult(profile, subjectRating, existing);
  }

  private existingSolveResult(
    profile: StudentGameProfile,
    subjectRating: StudentSubjectRating | null,
    solve: QuestionSolve,
  ): SolveResult {
    return {
      isCorrect: solve.is_correct,
      firstSolve: solve.first_solve,
      firstAttempt: false,
      suspicious: solve.suspicious,
      xpAwarded: solve.xp_awarded,
      xpBreakdown: [],
      ratingDelta: solve.rating_delta,
      subjectRating: subjectRating?.rating ?? STARTING_RATING,
      globalRating: profile.global_rating,
      combo: profile.current_combo,
      streak: profile.current_streak,
      streakExtendedToday: false,
      level: profile.level,
      levelUp: false,
      xp: profile.xp,
      rankTierId: profile.rank_tier_id,
      rankUp: false,
      alreadyAnswered: true,
      submittedAt: solve.created_at,
      response: solve.response,
    };
  }
}
