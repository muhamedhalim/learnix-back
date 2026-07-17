import type { Repository, SelectQueryBuilder } from 'typeorm';

import { ExamAttempt } from '../../exams/entities';
import { LeaderboardQueryDto } from '../dto/leaderboard-query.dto';
import { LeaderboardService } from './leaderboard.service';

describe('LeaderboardService public exam policy', () => {
  it('builds the public board exclusively from public graded exam attempts', async () => {
    const countQb = {
      select: jest.fn(),
      orderBy: jest.fn(),
      groupBy: jest.fn(),
      getRawOne: jest.fn().mockResolvedValue({ count: '0' }),
    };
    countQb.select.mockReturnValue(countQb);
    countQb.orderBy.mockReturnValue(countQb);
    countQb.groupBy.mockReturnValue(countQb);

    const qb: Record<string, jest.Mock> = {};
    for (const method of [
      'innerJoin',
      'leftJoin',
      'where',
      'andWhere',
      'select',
      'addSelect',
      'groupBy',
      'addGroupBy',
      'orderBy',
      'addOrderBy',
      'offset',
      'limit',
    ]) {
      qb[method] = jest.fn().mockReturnValue(qb);
    }
    qb['clone'] = jest.fn().mockReturnValue(countQb);
    qb['getRawMany'] = jest.fn().mockResolvedValue([]);

    const attempts = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValue(qb as unknown as SelectQueryBuilder<ExamAttempt>),
    } as unknown as Repository<ExamAttempt>;
    const service = new LeaderboardService({} as never, attempts);

    await service.getLeaderboard(new LeaderboardQueryDto());

    expect(qb['innerJoin']).toHaveBeenCalledWith(
      'exams',
      'exam',
      expect.stringContaining('exam.is_public = true'),
    );
    expect(qb['where']).toHaveBeenCalledWith('a.state = :graded', expect.any(Object));
  });
});
