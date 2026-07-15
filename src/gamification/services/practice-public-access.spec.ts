import { NotFoundException } from '@nestjs/common';

import type { Repository, SelectQueryBuilder } from 'typeorm';

import { Question } from '../../exams/entities';
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
});
