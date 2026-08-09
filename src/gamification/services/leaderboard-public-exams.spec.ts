import type { Repository, SelectQueryBuilder } from 'typeorm';

import {
  LeaderboardQueryDto,
  LeaderboardScope,
  LeaderboardWindow,
} from '../dto/leaderboard-query.dto';
import { QuestionSolve, StudentGameProfile, StudentSubjectRating } from '../entities';
import { LeaderboardService } from './leaderboard.service';

function queryBuilder(raw: unknown[] = []) {
  const countQb = {
    select: jest.fn(),
    orderBy: jest.fn(),
    groupBy: jest.fn(),
    getRawOne: jest.fn().mockResolvedValue({ count: String(raw.length) }),
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
  qb['getRawMany'] = jest.fn().mockResolvedValue(raw);
  return { qb, countQb };
}

describe('LeaderboardService public-practice policy', () => {
  it('uses the transactional game profile for the all-time public-practice board', async () => {
    const { qb, countQb } = queryBuilder([
      {
        user_id: 'student-1', username: 'learner', name: 'Learner', avatar_url: null,
        score: '1234.5', rating: '1234.5', xp: '80', level: 2, current_streak: 1,
        governorate: null, school: null,
        tier_slug: null, tier_name: null, tier_icon: null, tier_color: null, attempts: '2',
      },
    ]);
    const profiles = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as Repository<StudentGameProfile>;
    const service = new LeaderboardService(
      profiles,
      {} as Repository<StudentSubjectRating>,
      {} as Repository<QuestionSolve>,
    );

    const page = await service.getLeaderboard(new LeaderboardQueryDto());

    expect(profiles.createQueryBuilder).toHaveBeenCalledWith('gp');
    expect(qb['where']).toHaveBeenCalledWith('gp.total_solved > 0');
    expect(qb['addSelect']).toHaveBeenCalledWith('gp.global_rating', 'score');
    expect(countQb.select).toHaveBeenCalledWith('COUNT(DISTINCT gp.user_id)', 'count');
    expect(page.rows[0]).toMatchObject({ user_id: 'student-1', score: 1234.5, xp: 80, attempts: 2 });
  });

  it('uses only public, active practice solves for a weekly board', async () => {
    const { qb } = queryBuilder();
    const solves = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as Repository<QuestionSolve>;
    const service = new LeaderboardService(
      {} as Repository<StudentGameProfile>,
      {} as Repository<StudentSubjectRating>,
      solves,
    );
    const query = new LeaderboardQueryDto();
    query.window = LeaderboardWindow.WEEKLY;

    await service.getLeaderboard(query);

    expect(solves.createQueryBuilder).toHaveBeenCalledWith('qs');
    expect(qb['innerJoin']).toHaveBeenCalledWith(
      'questions',
      'q',
      expect.stringContaining('q.is_public = true'),
    );
    expect(qb['innerJoin']).toHaveBeenCalledWith(
      'questions',
      'q',
      expect.stringContaining('q.is_active = true'),
    );
    expect(qb['where']).toHaveBeenCalledWith('qs.created_at >= :since', expect.any(Object));
  });

  it('uses subject practice ratings, never private exam attempts, for a subject board', async () => {
    const { qb } = queryBuilder();
    const ratings = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as Repository<StudentSubjectRating>;
    const service = new LeaderboardService(
      {} as Repository<StudentGameProfile>,
      ratings,
      {} as Repository<QuestionSolve>,
    );
    const query = new LeaderboardQueryDto();
    query.scope = LeaderboardScope.SUBJECT;
    query.subject_id = 'b59f0f39-19e0-440f-9e63-77f9aa090a70';

    await service.getLeaderboard(query);

    expect(ratings.createQueryBuilder).toHaveBeenCalledWith('sr');
    expect(qb['andWhere']).toHaveBeenCalledWith('sr.solved > 0');
    expect(qb['innerJoin']).not.toHaveBeenCalledWith('exams', expect.anything(), expect.anything());
  });
});
