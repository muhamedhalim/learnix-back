import { Difficulty } from '../../exams/entities/difficulty.enum';
import {
  PracticeSession,
  QuestionSolve,
  StudentGameProfile,
  StudentQuestionState,
  StudentSubjectRating,
  XpEvent,
} from '../entities';
import { GamificationService } from './gamification.service';

describe('GamificationService practice scoring', () => {
  it('stores one final answer when duplicate requests arrive concurrently', async () => {
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
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === StudentGameProfile) return profileRepo;
        if (entity === StudentQuestionState) return stateRepo;
        if (entity === StudentSubjectRating) return ratingRepo;
        if (entity === QuestionSolve) return solveRepo;
        if (entity === XpEvent) return xpRepo;
        if (entity === PracticeSession) return sessionRepo;
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
    const service = new GamificationService(
      dataSource as never,
      { resolveTier: jest.fn().mockResolvedValue({ id: 'bronze' }) } as never,
      profileLookup as never,
      solveRepo as never,
    );
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
});
