import { Difficulty } from '../../exams/entities/difficulty.enum';
import {
  PracticeSession,
  QuestionSolve,
  StudentGameProfile,
  StudentQuestionState,
  StudentSubjectRating,
  StreakMilestoneAward,
  XpEvent,
  XpReason,
} from '../entities';
import { GamificationService } from './gamification.service';
import type { ResolvedRuleSet } from './gamification-rules.service';

const DEFAULT_RULE_SET: ResolvedRuleSet = {
  id: null,
  version_number: null,
  xp_base_by_difficulty: { easy: 10, medium: 20, hard: 35, expert: 55 },
  combo_bonuses: [
    { at: 5, xp: 15 },
    { at: 10, xp: 40 },
    { at: 20, xp: 100 },
  ],
  streak_daily_bonus: 25,
  streak_milestones: [
    { days: 7, xp: 100 },
    { days: 30, xp: 500 },
    { days: 100, xp: 2000 },
  ],
};

interface Harness {
  service: GamificationService;
  profile: StudentGameProfile;
  solves: QuestionSolve[];
  xpEvents: XpEvent[];
  campaignsService: { activeForLesson: jest.Mock };
  rulesService: { resolveCurrent: jest.Mock };
}

function buildHarness(options: {
  ruleSet?: ResolvedRuleSet;
  activeCampaign?: { id: string; bonus_xp: number } | null;
} = {}): Harness {
  const profile = {
    user_id: 'student-1', xp: 0, global_rating: 1200, level: 1,
    current_combo: 0, longest_combo: 0, current_streak: 0, longest_streak: 0,
    last_active_date: null, total_solved: 0, total_correct: 0, total_wrong: 0,
    total_time_ms: 0, rank_tier_id: null,
  } as StudentGameProfile;
  let state: StudentQuestionState | null = null;
  let subject = {
    user_id: 'student-1', subject_id: 'subject-1', rating: 1200, solved: 0, correct: 0,
  } as StudentSubjectRating;
  const solves: QuestionSolve[] = [];
  const xpEvents: XpEvent[] = [];

  const stateRepo = {
    findOne: jest.fn().mockImplementation(() => state),
    create: jest.fn().mockImplementation((value) => value),
    save: jest.fn().mockImplementation(async (value) => { state = value; return value; }),
  };
  const ratingRepo = {
    findOne: jest.fn().mockImplementation(() => (subject.solved === 0 ? null : subject)),
    create: jest.fn().mockImplementation((value) => value),
    save: jest.fn().mockImplementation(async (value) => { subject = value; return value; }),
    find: jest.fn().mockImplementation(async () => [subject]),
  };
  const solveRepo = {
    findOne: jest.fn().mockImplementation(async () => solves[0] ?? null),
    create: jest.fn().mockImplementation((value) => value),
    save: jest.fn().mockImplementation(async (value) => {
      const stored = { ...value, id: 'solve-1', created_at: new Date('2026-01-01T12:00:00Z') };
      solves.push(stored);
      return stored;
    }),
  };
  const xpRepo = {
    create: jest.fn().mockImplementation((value) => value),
    save: jest.fn().mockImplementation(async (value) => { xpEvents.push(value); return value; }),
  };
  const profileRepo = {
    findOneOrFail: jest.fn().mockResolvedValue(profile),
    save: jest.fn().mockResolvedValue(profile),
  };
  const sessionRepo = { findOne: jest.fn() };
  const milestoneRepo = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn((value) => value), save: jest.fn() };
  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === StudentGameProfile) return profileRepo;
      if (entity === StudentQuestionState) return stateRepo;
      if (entity === StudentSubjectRating) return ratingRepo;
      if (entity === QuestionSolve) return solveRepo;
      if (entity === XpEvent) return xpRepo;
      if (entity === PracticeSession) return sessionRepo;
      if (entity === StreakMilestoneAward) return milestoneRepo;
      throw new Error('Unexpected repository');
    },
  };
  let transactionTail = Promise.resolve();
  const dataSource = {
    transaction: (run: (manager: typeof manager) => Promise<unknown>) => {
      const current = transactionTail.then(() => run(manager));
      transactionTail = current.then(() => undefined, () => undefined);
      return current;
    },
  };
  const profileLookup = { findOne: jest.fn().mockResolvedValue(profile) };
  const rulesService = { resolveCurrent: jest.fn().mockResolvedValue(options.ruleSet ?? DEFAULT_RULE_SET) };
  const campaignsService = {
    activeForLesson: jest.fn().mockResolvedValue(options.activeCampaign ?? null),
  };
  const service = new GamificationService(
    dataSource as never,
    { resolveTier: jest.fn().mockResolvedValue({ id: 'bronze' }) } as never,
    profileLookup as never,
    solveRepo as never,
    rulesService as never,
    campaignsService as never,
  );
  return { service, profile, solves, xpEvents, campaignsService, rulesService };
}

describe('GamificationService practice scoring', () => {
  it('stores one final answer when duplicate requests arrive concurrently', async () => {
    const { service, profile, solves, xpEvents } = buildHarness();
    const input = {
      userId: 'student-1', questionId: 'question-1', questionVersion: 1,
      subjectId: 'subject-1', lessonId: null, difficulty: Difficulty.MEDIUM,
      isCorrect: true, response: { optionId: 'correct' }, timeMs: 5_000,
    };

    const [first, retry] = await Promise.all([service.recordSolve(input), service.recordSolve(input)]);

    expect(first).toMatchObject({ firstAttempt: true, firstSolve: true, alreadyAnswered: false });
    expect(first.xpAwarded).toBeGreaterThan(0);
    expect(first.ratingDelta).toBeGreaterThan(0);
    expect(retry).toMatchObject({
      firstAttempt: false,
      firstSolve: true,
      alreadyAnswered: true,
      xpAwarded: first.xpAwarded,
      ratingDelta: first.ratingDelta,
    });
    expect(profile.xp).toBe(first.xpAwarded);
    expect(profile.total_solved).toBe(1);
    expect(solves).toHaveLength(1);
    expect(xpEvents.reduce((total, event) => total + event.amount, 0)).toBe(first.xpAwarded);
  });

  /* --------------------------- DEF-018 --------------------------- */

  it('awards base XP from the currently resolved admin ruleset, not a hardcoded constant', async () => {
    const customRuleSet: ResolvedRuleSet = {
      ...DEFAULT_RULE_SET,
      id: 'rule-set-9',
      version_number: 9,
      xp_base_by_difficulty: { easy: 999, medium: 999, hard: 999, expert: 999 },
      // Zeroed so the first-ever-solve streak-start bonus doesn't muddy this
      // assertion — streak behavior has its own dedicated test coverage.
      streak_daily_bonus: 0,
    };
    const { service, xpEvents, rulesService } = buildHarness({ ruleSet: customRuleSet });
    const input = {
      userId: 'student-1', questionId: 'question-1', questionVersion: 1,
      subjectId: 'subject-1', lessonId: null, difficulty: Difficulty.MEDIUM,
      isCorrect: true, response: { optionId: 'correct' }, timeMs: 5_000,
    };

    const result = await service.recordSolve(input);

    expect(rulesService.resolveCurrent).toHaveBeenCalled();
    expect(result.xpAwarded).toBe(999);
    expect(xpEvents.find((event) => event.reason === XpReason.CORRECT_ANSWER)).toMatchObject({
      amount: 999,
    });
  });

  it('folds an active teacher campaign bonus into the same award for a lesson-linked solve', async () => {
    const { service, xpEvents, campaignsService } = buildHarness({
      ruleSet: { ...DEFAULT_RULE_SET, streak_daily_bonus: 0 },
      activeCampaign: { id: 'campaign-1', bonus_xp: 30 },
    });
    const input = {
      userId: 'student-1', questionId: 'question-1', questionVersion: 1,
      subjectId: 'subject-1', lessonId: 'lesson-1', difficulty: Difficulty.MEDIUM,
      isCorrect: true, response: { optionId: 'correct' }, timeMs: 5_000,
    };

    const result = await service.recordSolve(input);

    expect(campaignsService.activeForLesson).toHaveBeenCalledWith('lesson-1', expect.any(Date), expect.anything());
    // Default MEDIUM base (20) + campaign bonus (30) = 50.
    expect(result.xpAwarded).toBe(50);
    expect(xpEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: XpReason.CAMPAIGN_BONUS, amount: 30 })]),
    );
  });

  it('never looks up a campaign when the solve is not linked to a lesson', async () => {
    const { service, campaignsService } = buildHarness({ activeCampaign: { id: 'campaign-1', bonus_xp: 30 } });
    const input = {
      userId: 'student-1', questionId: 'question-1', questionVersion: 1,
      subjectId: 'subject-1', lessonId: null, difficulty: Difficulty.MEDIUM,
      isCorrect: true, response: { optionId: 'correct' }, timeMs: 5_000,
    };

    await service.recordSolve(input);

    expect(campaignsService.activeForLesson).not.toHaveBeenCalled();
  });

  it('never awards a campaign bonus for an incorrect or suspicious (too-fast) solve', async () => {
    const { service, xpEvents, campaignsService } = buildHarness({
      activeCampaign: { id: 'campaign-1', bonus_xp: 30 },
    });
    const input = {
      userId: 'student-1', questionId: 'question-1', questionVersion: 1,
      subjectId: 'subject-1', lessonId: 'lesson-1', difficulty: Difficulty.MEDIUM,
      isCorrect: false, response: { optionId: 'wrong' }, timeMs: 5_000,
    };

    const result = await service.recordSolve(input);

    expect(campaignsService.activeForLesson).not.toHaveBeenCalled();
    expect(result.xpAwarded).toBe(0);
    expect(xpEvents).toHaveLength(0);
  });
});
