import { Reflector } from '@nestjs/core';

import { ApplicationCacheService } from '../common/cache/application-cache.service';
import {
  INVALIDATES_CACHE_KEY,
  SKIP_CACHE_INVALIDATION_KEY,
} from '../common/cache/cache-invalidation.decorator';
import { StudentPracticeController } from './controllers/student-practice.controller';
import { GamificationPublicController } from './controllers/gamification-public.controller';
import {
  LeaderboardMetric,
  LeaderboardQueryDto,
  LeaderboardScope,
  LeaderboardWindow,
} from './dto/leaderboard-query.dto';
import { GamificationService } from './services/gamification.service';

/** A real key builder, so isolation is proven on the actual persisted keys. */
const keyBuilder = new ApplicationCacheService({} as never, {} as never);

interface Descriptor {
  family: string;
  endpoint: string;
  scope: string;
  parts: unknown[];
  ttlMs: number;
}

function buildController() {
  const calls: Descriptor[] = [];
  const applicationCache = {
    getOrCompute: jest.fn(async (descriptor: Descriptor, compute: () => Promise<unknown>) => {
      calls.push(descriptor);
      return await compute();
    }),
  };
  const leaderboard = { getLeaderboard: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
  const profiles = { getByUsername: jest.fn().mockResolvedValue({ username: 'ali' }) };
  const controller = new GamificationPublicController(
    leaderboard as never,
    {} as never,
    profiles as never,
    applicationCache as never,
  );
  return { controller, calls, applicationCache, leaderboard, profiles };
}

function query(overrides: Partial<LeaderboardQueryDto> = {}): LeaderboardQueryDto {
  return Object.assign(new LeaderboardQueryDto(), overrides);
}

const keyOf = (descriptor: Descriptor) => keyBuilder.buildKey(descriptor as never);

describe('GamificationPublicController caching (T037 b, c)', () => {
  it('caches the public profile under the shared public scope for 60 s, keyed by the exact username', async () => {
    const { controller, calls, profiles } = buildController();

    await controller.getProfile('Ali_99');

    expect(calls).toEqual([
      {
        family: 'gamification_public',
        endpoint: 'gamification.public-profile',
        scope: 'public',
        parts: ['Ali_99'],
        ttlMs: 60_000,
      },
    ]);
    expect(profiles.getByUsername).toHaveBeenCalledWith('Ali_99');
  });

  it('never folds username case: usernames are case-sensitive, so two users must not share an entry', async () => {
    const { controller, calls } = buildController();

    await controller.getProfile('Ali');
    await controller.getProfile('ali');

    expect(keyOf(calls[0]!)).not.toEqual(keyOf(calls[1]!));
  });

  it('caches the leaderboard with every query dimension in the key', async () => {
    const { controller, calls } = buildController();
    const subjectId = '11111111-1111-4111-8111-111111111111';

    await controller.getLeaderboard(query());
    await controller.getLeaderboard(query({ page: 2 }));
    await controller.getLeaderboard(query({ limit: 50 }));
    await controller.getLeaderboard(query({ window: LeaderboardWindow.WEEKLY }));
    await controller.getLeaderboard(query({ metric: LeaderboardMetric.XP }));
    await controller.getLeaderboard(
      query({ scope: LeaderboardScope.SUBJECT, subject_id: subjectId }),
    );
    await controller.getLeaderboard(
      query({ scope: LeaderboardScope.GOVERNORATE, governorate: 'Cairo' }),
    );
    await controller.getLeaderboard(
      query({ scope: LeaderboardScope.GOVERNORATE, governorate: 'cairo' }),
    );

    const keys = calls.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);
    expect(calls.every((c) => c.family === 'gamification_public' && c.scope === 'public')).toBe(
      true,
    );
    expect(
      calls.every((c) => c.endpoint === 'gamification.leaderboard' && c.ttlMs === 60_000),
    ).toBe(true);
  });

  it('gives identical queries the same key regardless of property assignment order', async () => {
    const { controller, calls } = buildController();
    const a = query({ page: 3, limit: 10 });
    const b = new LeaderboardQueryDto();
    b.limit = 10;
    b.page = 3;

    await controller.getLeaderboard(a);
    await controller.getLeaderboard(b);

    expect(keyOf(calls[0]!)).toEqual(keyOf(calls[1]!));
  });

  it('keeps the profile and the leaderboard apart even when their parts look alike', async () => {
    const { controller, calls } = buildController();

    await controller.getProfile('global');
    await controller.getLeaderboard(query());

    expect(keyOf(calls[0]!)).not.toEqual(keyOf(calls[1]!));
  });

  it('lets errors (private/unknown profile 404, missing scope filter 400) propagate uncached', async () => {
    const { controller, profiles, leaderboard } = buildController();
    profiles.getByUsername.mockRejectedValue(new Error('Profile not found'));
    leaderboard.getLeaderboard.mockRejectedValue(new Error('subject_id is required'));

    await expect(controller.getProfile('hidden')).rejects.toThrow('Profile not found');
    await expect(
      controller.getLeaderboard(query({ scope: LeaderboardScope.SUBJECT })),
    ).rejects.toThrow('subject_id is required');
  });

  it('does not cache the anonymous scopes and ranks routes it does not wrap', () => {
    const { controller, applicationCache } = buildController();

    controller.getScopes();

    expect(applicationCache.getOrCompute).not.toHaveBeenCalled();
  });
});

describe('practice routes invalidate gamification_public (T037 writers)', () => {
  const reflector = new Reflector();
  const proto = StudentPracticeController.prototype;

  it('declares the whole gamification_public family (and the answering student\'s own student_quiz_analytics slice, T040) on practice/answer and drops the temporary skip', () => {
    expect(reflector.get(INVALIDATES_CACHE_KEY, proto.answer)).toEqual([
      'gamification_public',
      { family: 'student_quiz_analytics', scope: 'self' },
    ]);
    expect(reflector.get(SKIP_CACHE_INVALIDATION_KEY, proto.answer)).toBeUndefined();
  });

  it('declares gamification_public on practice/session', () => {
    expect(reflector.get(INVALIDATES_CACHE_KEY, proto.startSession)).toEqual([
      'gamification_public',
    ]);
    expect(reflector.get(SKIP_CACHE_INVALIDATION_KEY, proto.startSession)).toBeUndefined();
  });

  it('declares nothing on the read-only practice routes', () => {
    expect(reflector.get(INVALIDATES_CACHE_KEY, proto.myProfile)).toBeUndefined();
    expect(reflector.get(INVALIDATES_CACHE_KEY, proto.next)).toBeUndefined();
  });
});

describe('GamificationService public cache invalidation (T037 writers)', () => {
  function build(options: { existing?: boolean; saveFails?: boolean; affected?: number } = {}) {
    const applicationCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const created = { user_id: 'student-1', xp: 0 };
    const profiles = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(options.existing === true ? created : null)
        // The concurrent-create re-read after a failed insert.
        .mockResolvedValue(created),
      create: jest.fn().mockReturnValue(created),
      save:
        options.saveFails === true
          ? jest.fn().mockRejectedValue(new Error('unique(user_id)'))
          : jest.fn().mockResolvedValue(created),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: options.affected ?? 0 }),
      }),
    };
    const service = new GamificationService(
      {} as never,
      {} as never,
      profiles as never,
      {} as never,
      {} as never,
      {} as never,
      applicationCache as never,
    );
    return { service, applicationCache, profiles };
  }

  it('invalidates the public family when ensureProfile inserts a new profile', async () => {
    const { service, applicationCache } = build();

    await service.ensureProfile('student-1');

    expect(applicationCache.invalidate).toHaveBeenCalledTimes(1);
    expect(applicationCache.invalidate).toHaveBeenCalledWith(['gamification_public']);
  });

  it('does not invalidate when the profile already exists (nothing was written)', async () => {
    const { service, applicationCache, profiles } = build({ existing: true });

    await service.ensureProfile('student-1');

    expect(profiles.save).not.toHaveBeenCalled();
    expect(applicationCache.invalidate).not.toHaveBeenCalled();
  });

  it('does not invalidate on the concurrent-create re-read path (the other request inserted)', async () => {
    const { service, applicationCache } = build({ saveFails: true });

    await expect(service.ensureProfile('student-1')).resolves.toBeDefined();

    expect(applicationCache.invalidate).not.toHaveBeenCalled();
  });

  it('never fails the profile creation because the cache is unavailable', async () => {
    const { service, applicationCache } = build();
    applicationCache.invalidate.mockRejectedValue(new Error('redis down'));

    await expect(service.ensureProfile('student-1')).resolves.toEqual(
      expect.objectContaining({ user_id: 'student-1' }),
    );
  });

  it('invalidates after a streak sweep that reset at least one row', async () => {
    const { service, applicationCache } = build({ affected: 3 });

    await expect(service.sweepLapsedStreaks()).resolves.toBe(3);

    expect(applicationCache.invalidate).toHaveBeenCalledWith(['gamification_public']);
  });

  it('does not invalidate after a streak sweep that changed nothing', async () => {
    const { service, applicationCache } = build({ affected: 0 });

    await expect(service.sweepLapsedStreaks()).resolves.toBe(0);

    expect(applicationCache.invalidate).not.toHaveBeenCalled();
  });

  it('still returns the sweep count when the cache is unavailable', async () => {
    const { service, applicationCache } = build({ affected: 2 });
    applicationCache.invalidate.mockRejectedValue(new Error('redis down'));

    await expect(service.sweepLapsedStreaks()).resolves.toBe(2);
  });
});
