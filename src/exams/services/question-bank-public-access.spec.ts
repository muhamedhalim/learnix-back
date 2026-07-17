import type { Repository, SelectQueryBuilder } from 'typeorm';

import type { Question } from '../entities';
import { QuestionBankService } from './question-bank.service';

describe('QuestionBankService public question listing', () => {
  function makeQuestion(id: string): Question {
    return {
      id,
      subject_id: 'subject-1',
      lesson_id: null,
      chapter: null,
      topic: 'Algebra',
      type: 'single_choice',
      difficulty: 'easy',
      content: { prompt: { en: 'What is 2 + 2?' } },
      answer_key: { optionId: 'correct-option' },
      default_marks: 1,
      tags: ['addition'],
      subject: { id: 'subject-1', name: 'Mathematics', name_ar: 'الرياضيات' },
      created_at: new Date('2026-07-17T00:00:00.000Z'),
    } as Question;
  }

  function makeService(rows: Question[]) {
    const andWhere = jest.fn();
    const qb = {
      leftJoinAndSelect: jest.fn(),
      where: jest.fn(),
      andWhere,
      orderBy: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getManyAndCount: jest.fn().mockResolvedValue([rows, rows.length]),
    } as unknown as SelectQueryBuilder<Question>;
    for (const method of ['leftJoinAndSelect', 'where', 'orderBy', 'skip', 'take'] as const) {
      (qb[method] as jest.Mock).mockReturnValue(qb);
    }
    andWhere.mockReturnValue(qb);
    const questions = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as Repository<Question>;
    return {
      service: new QuestionBankService(
        questions,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      ),
      where: qb.where as jest.Mock,
      andWhere,
    };
  }

  it('returns an active public standalone question without requiring an exam', async () => {
    const { service, andWhere } = makeService([makeQuestion('public-question')]);

    const result = await service.findPublic({ page: 1, limit: 20 });

    expect(andWhere).toHaveBeenCalledWith('q.is_active = true');
    expect(andWhere).toHaveBeenCalledWith('q.deleted_at IS NULL');
    expect(result.data).toEqual([
      expect.objectContaining({
        id: 'public-question',
        content: { prompt: { en: 'What is 2 + 2?' } },
      }),
    ]);
    expect(result.data[0]).not.toHaveProperty('answer_key');
  });

  it('persists the explicit public flag supplied by the instructor', async () => {
    const manager = {
      create: jest.fn((_entity: unknown, values: Record<string, unknown>) => values),
      save: jest
        .fn()
        .mockResolvedValueOnce({ ...makeQuestion('saved-public-question'), is_public: true })
        .mockResolvedValueOnce(undefined),
    };
    const dataSource = {
      transaction: jest.fn((callback: (transactionManager: typeof manager) => unknown) =>
        callback(manager),
      ),
    };
    const service = new QuestionBankService(
      {} as never,
      {} as never,
      { findOne: jest.fn().mockResolvedValue({ id: 'subject-1' }) } as never,
      {} as never,
      { require: () => ({ validateAuthoring: () => [] }) } as never,
      dataSource as never,
    );

    const saved = await service.create('teacher-1', {
      type: 'single_choice',
      subject_id: 'subject-1',
      content: { prompt: { en: 'What is 2 + 2?' } },
      answer_key: { optionId: 'correct-option' },
      default_marks: 1,
      is_public: true,
    });

    expect(manager.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ teacher_id: 'teacher-1', is_public: true }),
    );
    expect(saved.is_public).toBe(true);
  });

  it('enforces the public predicate so private questions never enter the student query', async () => {
    const { service, where, andWhere } = makeService([]);

    const result = await service.findPublic({ page: 1, limit: 20 });

    // The first predicate is deliberately the public gate; all subsequent
    // conditions only narrow that already-safe result set.
    expect(where).toHaveBeenCalledWith('q.is_public = true');
    expect(andWhere).toHaveBeenCalledWith('q.is_active = true');
    expect(result.data).toEqual([]);
  });
});
