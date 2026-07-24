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
  it('awards a public question only once when the same submission is retried', async () => {
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
      create: jest.fn().mockImplementation((value) => value),
      save: jest.fn().mockImplementation(async (value) => { solves.push(value); return value; }),
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
    const dataSource = {
      transaction: (run: (manager: typeof manager) => unknown) => run(manager),
    };
    const profileLookup = { findOne: jest.fn().mockResolvedValue(profile) };
    const service = new GamificationService(
      dataSource as never,
      { resolveTier: jest.fn().mockResolvedValue({ id: 'bronze' }) } as never,
      profileLookup as never,
    );
    const input = {
      userId: 'student-1', questionId: 'question-1', questionVersion: 1,
      subjectId: 'subject-1', lessonId: null, difficulty: Difficulty.MEDIUM,
      isCorrect: true, response: { optionId: 'correct' }, timeMs: 5_000,
    };

    const first = await service.recordSolve(input);
    const retry = await service.recordSolve(input);

    expect(first).toMatchObject({ firstAttempt: true, firstSolve: true });
    expect(first.xpAwarded).toBeGreaterThan(0);
    expect(first.ratingDelta).toBeGreaterThan(0);
    expect(retry).toMatchObject({ firstAttempt: false, firstSolve: false, xpAwarded: 0, ratingDelta: 0 });
    expect(profile.xp).toBe(first.xpAwarded);
    expect(solves).toHaveLength(2);
    expect(solves[1]).toMatchObject({ xp_awarded: 0, rating_delta: 0, first_solve: false });
    expect(xpEvents.reduce((total, event) => total + event.amount, 0)).toBe(first.xpAwarded);
  });
});
