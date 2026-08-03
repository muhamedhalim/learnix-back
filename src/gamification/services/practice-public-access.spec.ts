import { NotFoundException } from '@nestjs/common';

import type { Repository, SelectQueryBuilder } from 'typeorm';

import { Question } from '../../exams/entities';
import { Difficulty } from '../../exams/entities/difficulty.enum';
import { PracticeService } from './practice.service';

describe('PracticeService public-content policy', () => {
  it('filters the leaderboard practice pool to is_public questions', async () => {
    const andWhere = jest.fn();
    const qb = {
      where: jest.fn(),
      andWhere,
      orderBy: jest.fn(),
      limit: jest.fn(),
      getOne: jest.fn().mockResolvedValue(null),
    } as unknown as SelectQueryBuilder<Question>;
    (qb.where as jest.Mock).mockReturnValue(qb);
    andWhere.mockReturnValue(qb);
    (qb.orderBy as jest.Mock).mockReturnValue(qb);
    (qb.limit as jest.Mock).mockReturnValue(qb);

    const questions = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as Repository<Question>;
    const service = new PracticeService(
      questions,
      {} as never,
      {} as never,
      { list: () => [] } as never,
      {} as never,
      {} as never,
      {} as never,
      { upsert: jest.fn() } as never,
      {} as never,
    );

    await service.getNext('student-1', {});

    expect(andWhere).toHaveBeenCalledWith('q.is_public = true');
  });

  it('does not reveal or accept answers for a private instructor question', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const questions = { findOne } as unknown as Repository<Question>;
    const service = new PracticeService(
      questions,
      {} as never,
      {} as never,
      {} as never,
      { findOne: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.submitAnswer('student-1', {
        questionId: 'private-question',
        response: null,
        timeMs: 100,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findOne).toHaveBeenCalledWith({
      where: { id: 'private-question', is_active: true, is_public: true },
    });
  });

  it('returns the stored review instead of a second answer opportunity', async () => {
    const question = {
      id: 'answered-question', type: 'true_false', subject_id: 'subject-1', lesson_id: null,
      difficulty: Difficulty.EASY, content: { prompt: 'True?' }, answer_key: { value: true },
    } as Question;
    const qb = {
      where: jest.fn(), andWhere: jest.fn(), orderBy: jest.fn(), limit: jest.fn(),
      getOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(question),
    } as unknown as SelectQueryBuilder<Question>;
    for (const method of ['where', 'andWhere', 'orderBy', 'limit'] as const) {
      (qb[method] as jest.Mock).mockReturnValue(qb);
    }
    const previous = {
      isCorrect: true, firstSolve: true, firstAttempt: false, suspicious: false,
      xpAwarded: 20, xpBreakdown: [], ratingDelta: 20, subjectRating: 1220,
      globalRating: 1220, combo: 2, streak: 1, streakExtendedToday: false,
      level: 1, levelUp: false, xp: 45, rankTierId: null, rankUp: false,
      alreadyAnswered: true, submittedAt: new Date('2026-01-01T12:00:00Z'), response: { value: true },
    };
    const service = new PracticeService(
      { createQueryBuilder: jest.fn().mockReturnValue(qb) } as unknown as Repository<Question>,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      { list: () => [{ type: 'true_false', requiresManualGrading: false }] } as never,
      { existingSolveResultFor: jest.fn().mockResolvedValue(previous) } as never,
      {} as never,
      {} as never,
      { upsert: jest.fn() } as never,
      {} as never,
    );

    const rendered = await service.getNext('student-1', {});

    expect(rendered).toMatchObject({
      id: 'answered-question', already_solved: true,
      previous_result: { alreadyAnswered: true, response: { value: true }, solution: { value: true } },
    });
  });

  it('grades a public question on the server and records the authenticated student only', async () => {
    const question = {
      id: 'public-question',
      type: 'single_choice',
      current_version: 3,
      subject_id: 'subject-1',
      lesson_id: null,
      difficulty: Difficulty.MEDIUM,
      answer_key: { optionId: 'correct' },
      content: { explanation: 'Because it is correct.' },
    } as Question;
    const findOne = jest.fn().mockResolvedValue(question);
    const recordSolve = jest.fn().mockResolvedValue({
      isCorrect: true, firstSolve: true, firstAttempt: true, suspicious: false,
      xpAwarded: 20, xpBreakdown: [], ratingDelta: 20, subjectRating: 1220,
      globalRating: 1220, combo: 1, streak: 1, streakExtendedToday: true,
      level: 1, levelUp: false, xp: 45, rankTierId: null, rankUp: false,
    });
    const service = new PracticeService(
      { findOne } as unknown as Repository<Question>,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      {
        require: () => ({
          validateResponse: () => [],
          grade: (response: { optionId: string }) => ({
            isCorrect: response.optionId === 'correct', manualRequired: false,
          }),
        }),
      } as never,
      { recordSolve, existingSolveResultFor: jest.fn().mockResolvedValue(null) } as never,
      { resolveTier: jest.fn().mockResolvedValue(null) } as never,
      { notifyForSolve: jest.fn() } as never,
      { findOne: jest.fn().mockResolvedValue({ served_at: new Date(Date.now() - 5_000) }) } as never,
      {} as never,
    );

    const result = await service.submitAnswer('authenticated-student', {
      questionId: question.id,
      response: { optionId: 'correct' },
      timeMs: 5_000,
    });

    expect(recordSolve).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'authenticated-student',
      questionId: question.id,
      isCorrect: true,
      difficulty: Difficulty.MEDIUM,
    }));
    expect(result).toMatchObject({ isCorrect: true, xpAwarded: 20, solution: question.answer_key });
  });

  it('returns the original result for a duplicate submission without grading or recording again', async () => {
    const question = {
      id: 'public-question', type: 'true_false', current_version: 1,
      subject_id: 'subject-1', lesson_id: null, difficulty: Difficulty.EASY,
      answer_key: { value: true }, content: {},
    } as Question;
    const existing = {
      isCorrect: true, firstSolve: true, firstAttempt: false, suspicious: false,
      xpAwarded: 10, xpBreakdown: [], ratingDelta: 20, subjectRating: 1220,
      globalRating: 1220, combo: 1, streak: 1, streakExtendedToday: false,
      level: 1, levelUp: false, xp: 35, rankTierId: null, rankUp: false,
      alreadyAnswered: true, submittedAt: new Date('2026-01-01T12:00:00Z'), response: { value: true },
    };
    const recordSolve = jest.fn();
    const registry = { require: jest.fn() };
    const service = new PracticeService(
      { findOne: jest.fn().mockResolvedValue(question) } as unknown as Repository<Question>,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      registry as never,
      { recordSolve, existingSolveResultFor: jest.fn().mockResolvedValue(existing) } as never,
      {} as never,
      {} as never,
      { findOne: jest.fn() } as never,
      {} as never,
    );

    const result = await service.submitAnswer('student-1', {
      questionId: question.id, response: { value: false }, timeMs: 0,
    });

    expect(result).toMatchObject({ alreadyAnswered: true, response: { value: true } });
    expect(registry.require).not.toHaveBeenCalled();
    expect(recordSolve).not.toHaveBeenCalled();
  });

  it('rejects an answer for a question the server did not serve to the student', async () => {
    const question = {
      id: 'unserved-question', type: 'true_false', current_version: 1,
      subject_id: 'subject-1', lesson_id: null, difficulty: Difficulty.EASY,
      answer_key: { value: true }, content: {},
    } as Question;
    const service = new PracticeService(
      { findOne: jest.fn().mockResolvedValue(question) } as unknown as Repository<Question>,
      {} as never,
      {} as never,
      { require: jest.fn() } as never,
      { existingSolveResultFor: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      {} as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
    );

    await expect(service.submitAnswer('student-1', {
      questionId: question.id, response: { value: true }, timeMs: 1,
    })).rejects.toThrow('Question was not served');
  });

  it('records an incorrect public answer without awarding a correct-answer result', async () => {
    const question = {
      id: 'public-question', type: 'true_false', current_version: 1,
      subject_id: 'subject-1', lesson_id: null, difficulty: Difficulty.EASY,
      answer_key: { value: true }, content: {},
    } as Question;
    const recordSolve = jest.fn().mockResolvedValue({
      isCorrect: false, firstSolve: false, firstAttempt: true, suspicious: false,
      xpAwarded: 0, xpBreakdown: [], ratingDelta: -20, subjectRating: 1180,
      globalRating: 1180, combo: 0, streak: 0, streakExtendedToday: false,
      level: 1, levelUp: false, xp: 0, rankTierId: null, rankUp: false,
    });
    const service = new PracticeService(
      { findOne: jest.fn().mockResolvedValue(question) } as unknown as Repository<Question>,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      { require: () => ({ validateResponse: () => [], grade: () => ({ isCorrect: false, manualRequired: false }) }) } as never,
      { recordSolve, existingSolveResultFor: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      {} as never,
      { findOne: jest.fn().mockResolvedValue({ served_at: new Date(Date.now() - 5_000) }) } as never,
      {} as never,
    );

    const result = await service.submitAnswer('authenticated-student', {
      questionId: question.id,
      response: { value: false },
      timeMs: 5_000,
    });

    expect(recordSolve).toHaveBeenCalledWith(expect.objectContaining({ isCorrect: false }));
    expect(result).toMatchObject({ isCorrect: false, xpAwarded: 0 });
  });
});
