import type { Server } from 'node:http';

import request from 'supertest';

import {
  ApplicationCacheService,
  type ApplicationCacheFamily,
} from '../../src/common/cache/application-cache.service';
import { GamificationService } from '../../src/gamification/services/gamification.service';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';

/**
 * Spec 004 Wave 1 (T037 b and c): the anonymous public gamification profile (`GET u/:username`) and
 * leaderboard (`GET leaderboard`) are cached in family `gamification_public`.
 *
 * Every state change goes through the real HTTP route (or the real service for the non-HTTP sweep) and
 * is followed by an immediate re-read, never a TTL wait: a stale entry can only mean a missing
 * invalidation. "Served from the cache" is proven with a write that BYPASSES the API (raw SQL) which a
 * cached read must not show; the control step bumps the family by hand to prove that write was real.
 *
 * Users are created up front: registration is an undeclared mutation (global bump) and would evict any
 * entry warmed earlier in the same test.
 */

interface PublicProfile {
  username: string;
  name: string;
  xp: number;
  rating: number;
  total_solved: number;
  current_streak: number;
  global_rank: number | null;
}

interface LeaderboardRow {
  username: string;
  name: string;
  xp: number;
  attempts: number;
  current_streak: number;
}

interface Leaderboard {
  rows: LeaderboardRow[];
  total: number;
  page: number;
  limit: number;
}

interface CacheWatch {
  invalidateAll: jest.SpyInstance;
  invalidate: jest.SpyInstance;
  invalidateScopes: jest.SpyInstance;
}

interface PublicStudent {
  user: AuthenticatedUser;
  username: string;
}

describe('public gamification cache: freshness, privacy and isolation (spec 004 T037 b/c)', () => {
  let ctx: E2EContext;
  let cache: ApplicationCacheService;
  let subjectId: string;
  let teacherId: string;

  const server = (): Server => ctx.app.getHttpServer() as Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    cache = ctx.app.get(ApplicationCacheService);
  });

  afterAll(async () => ctx.app.close());

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    const [{ id: subject }] = (await ctx.dataSource.query(
      `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'Gamification Cache Subject') RETURNING id`,
    )) as [{ id: string }];
    subjectId = subject;
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'teacher',
      overrides: { requestedRole: 'teacher' },
    });
    teacherId = teacher.userId;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------------------------
  // Fixtures (raw SQL; no HTTP, so nothing here invalidates a cache generation)
  // ---------------------------------------------------------------------------------------------

  async function usernameOf(userId: string): Promise<string> {
    const [row] = (await ctx.dataSource.query(`SELECT username FROM users WHERE id = $1`, [
      userId,
    ])) as [{ username: string }];
    return row.username;
  }

  /** A registered, approved student whose public profile flag is set directly in the database. */
  async function createStudent(isPublic: boolean): Promise<PublicStudent> {
    const user = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'student' });
    const existing = (await ctx.dataSource.query(
      `SELECT 1 FROM student_profiles WHERE user_id = $1`,
      [user.userId],
    )) as unknown[];
    if (existing.length === 0) {
      await ctx.dataSource.query(
        `INSERT INTO student_profiles (id, user_id, is_public_profile) VALUES (gen_random_uuid(), $1, $2)`,
        [user.userId, isPublic],
      );
    } else {
      await ctx.dataSource.query(
        `UPDATE student_profiles SET is_public_profile = $2 WHERE user_id = $1`,
        [user.userId, isPublic],
      );
    }
    return { user, username: await usernameOf(user.userId) };
  }

  async function giveGameProfile(
    userId: string,
    values: { xp?: number; totalSolved?: number; streak?: number; lastActive?: string | null } = {},
  ): Promise<void> {
    await ctx.dataSource.query(
      `INSERT INTO student_game_profiles (id, user_id, xp, total_solved, current_streak, last_active_date)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [
        userId,
        values.xp ?? 10,
        values.totalSolved ?? 1,
        values.streak ?? 0,
        values.lastActive ?? null,
      ],
    );
  }

  /** A public, active, objective practice question every student may be served. */
  async function createPracticeQuestion(): Promise<void> {
    await ctx.dataSource.query(
      `INSERT INTO questions (id, teacher_id, subject_id, type, content, answer_key, default_marks, is_public, is_active)
       VALUES (gen_random_uuid(), $1, $2, 'single_choice', $3, $4, 1, true, true)`,
      [
        teacherId,
        subjectId,
        JSON.stringify({
          prompt: { en: 'Pick B' },
          options: [
            { id: 'opt_0', text: { en: 'A' } },
            { id: 'opt_1', text: { en: 'B' } },
          ],
        }),
        JSON.stringify({ correctOptionId: 'opt_1' }),
      ],
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Reads (anonymous, exactly what a visitor does)
  // ---------------------------------------------------------------------------------------------

  async function getProfile(username: string, expected = 200): Promise<PublicProfile> {
    const res = await request(server()).get(`${API_PREFIX}/u/${username}`).expect(expected);
    return res.body as PublicProfile;
  }

  async function getLeaderboard(query = ''): Promise<Leaderboard> {
    const res = await request(server()).get(`${API_PREFIX}/leaderboard${query}`).expect(200);
    return res.body as Leaderboard;
  }

  const rowFor = (board: Leaderboard, username: string): LeaderboardRow | undefined =>
    board.rows.find((row) => row.username === username);

  function watchCache(): CacheWatch {
    return {
      invalidateAll: jest.spyOn(cache, 'invalidateAll'),
      invalidate: jest.spyOn(cache, 'invalidate'),
      invalidateScopes: jest.spyOn(cache, 'invalidateScopes'),
    };
  }

  const familiesOf = (spy: jest.SpyInstance): ApplicationCacheFamily[][] =>
    spy.mock.calls.map((call) => [...(call[0] as ApplicationCacheFamily[])]);

  // ---------------------------------------------------------------------------------------------
  // The cache is real
  // ---------------------------------------------------------------------------------------------

  describe('the two reads are served from the cache', () => {
    it('a write that bypasses the API stays hidden on a repeat read until the family is bumped', async () => {
      const student = await createStudent(true);
      await giveGameProfile(student.user.userId, { xp: 30, totalSolved: 3 });

      const warmedProfile = await getProfile(student.username);
      const warmedBoard = await getLeaderboard();
      expect(warmedProfile.xp).toBe(30);
      expect(rowFor(warmedBoard, student.username)?.xp).toBe(30);

      await ctx.dataSource.query(`UPDATE student_game_profiles SET xp = 99 WHERE user_id = $1`, [
        student.user.userId,
      ]);

      // Hidden: both reads are hits.
      expect((await getProfile(student.username)).xp).toBe(30);
      expect(rowFor(await getLeaderboard(), student.username)?.xp).toBe(30);

      // Control: the write was real; bumping the family reveals it.
      await cache.invalidate(['gamification_public']);
      expect((await getProfile(student.username)).xp).toBe(99);
      expect(rowFor(await getLeaderboard(), student.username)?.xp).toBe(99);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Privacy and identity changes apply on the very next request (the key regression guard)
  // ---------------------------------------------------------------------------------------------

  describe('privacy and identity writers are immediate', () => {
    it('making the profile private through the API hides it from /u/:username and the leaderboard at once', async () => {
      const student = await createStudent(true);
      await giveGameProfile(student.user.userId);

      expect(await getProfile(student.username)).toMatchObject({ username: student.username });
      expect(rowFor(await getLeaderboard(), student.username)).toBeDefined();

      await student.user.agent
        .put(`${API_PREFIX}/student/profile`)
        .send({ is_public_profile: false })
        .expect(200);

      await getProfile(student.username, 404);
      expect(rowFor(await getLeaderboard(), student.username)).toBeUndefined();
    });

    it('making a private profile public through the API shows it at once (no cached 404)', async () => {
      const student = await createStudent(false);
      await giveGameProfile(student.user.userId);

      await getProfile(student.username, 404);
      expect(rowFor(await getLeaderboard(), student.username)).toBeUndefined();

      await student.user.agent
        .put(`${API_PREFIX}/student/profile`)
        .send({ is_public_profile: true })
        .expect(200);

      expect(await getProfile(student.username)).toMatchObject({ username: student.username });
      expect(rowFor(await getLeaderboard(), student.username)).toBeDefined();
    });

    it('a display-name change through the API is shown by /u/:username and the leaderboard at once', async () => {
      const student = await createStudent(true);
      await giveGameProfile(student.user.userId);

      const before = await getProfile(student.username);
      expect(rowFor(await getLeaderboard(), student.username)?.name).toBe(before.name);

      await student.user.agent
        .put(`${API_PREFIX}/users/me`)
        .send({ name: 'Renamed Cache Student' })
        .expect(200);

      expect((await getProfile(student.username)).name).toBe('Renamed Cache Student');
      expect(rowFor(await getLeaderboard(), student.username)?.name).toBe('Renamed Cache Student');
    });

    it('an error is never cached: a 404 followed by a write that bypasses the API is not served again', async () => {
      const student = await createStudent(false);
      await giveGameProfile(student.user.userId);

      await getProfile(student.username, 404);
      await ctx.dataSource.query(
        `UPDATE student_profiles SET is_public_profile = true WHERE user_id = $1`,
        [student.user.userId],
      );

      // No invalidation happened; a cached 404 would still be served.
      expect(await getProfile(student.username)).toMatchObject({ username: student.username });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Practice writers
  // ---------------------------------------------------------------------------------------------

  describe('practice answer (declared route)', () => {
    it('reflects the answer in /u/:username and the leaderboard on the next request, invalidating only gamification_public', async () => {
      const student = await createStudent(true);
      // The profile already exists, so ONLY the route declaration (not `ensureProfile`) can invalidate.
      await giveGameProfile(student.user.userId, { xp: 10, totalSolved: 1 });
      await createPracticeQuestion();

      expect((await getProfile(student.username)).total_solved).toBe(1);
      expect(rowFor(await getLeaderboard(), student.username)?.attempts).toBe(1);

      const next = await student.user.agent.get(`${API_PREFIX}/student/practice/next`).expect(200);
      const questionId = (next.body as { question: { id: string } }).question.id;

      const watch = watchCache();
      await student.user.agent
        .post(`${API_PREFIX}/student/practice/answer`)
        .send({ question_id: questionId, response: { optionId: 'opt_1' }, time_ms: 1500 })
        .expect(201);

      // Exactly the declared families: no global bump; the family-level `gamification_public` bump
      // (every viewer's leaderboard/profile ranks may have moved) plus the answering student's own
      // `student_quiz_analytics` slice (T040: `question_solves` also feeds performance insights) —
      // never any other student's `student_quiz_analytics` scope.
      expect(watch.invalidateAll).not.toHaveBeenCalled();
      expect(familiesOf(watch.invalidate)).toEqual([['gamification_public']]);
      expect(watch.invalidateScopes).toHaveBeenCalledWith([
        { family: 'student_quiz_analytics', scope: `owner:${student.user.userId}` },
      ]);

      expect((await getProfile(student.username)).total_solved).toBe(2);
      expect(rowFor(await getLeaderboard(), student.username)?.attempts).toBe(2);
    });
  });

  describe('first game profile (insert-only invalidation)', () => {
    it('POST student/practice/session that creates the profile reflects it in /u/:username at once', async () => {
      const student = await createStudent(true);

      // No game profile yet: the profile has no global rank.
      expect((await getProfile(student.username)).global_rank).toBeNull();

      await student.user.agent.post(`${API_PREFIX}/student/practice/session`).send({}).expect(201);

      expect((await getProfile(student.username)).global_rank).toBe(1);
    });

    it('GET student/game/profile (a write on a GET) also reflects the new profile, through the service-level invalidation', async () => {
      const student = await createStudent(true);
      expect((await getProfile(student.username)).global_rank).toBeNull();

      const watch = watchCache();
      await student.user.agent.get(`${API_PREFIX}/student/game/profile`).expect(200);

      // A GET never reaches the interceptor: only the service can have invalidated, and only once.
      expect(watch.invalidateAll).not.toHaveBeenCalled();
      expect(familiesOf(watch.invalidate)).toEqual([['gamification_public']]);
      expect((await getProfile(student.username)).global_rank).toBe(1);
    });

    it('a second GET with the profile already present invalidates nothing', async () => {
      const student = await createStudent(true);
      await student.user.agent.get(`${API_PREFIX}/student/game/profile`).expect(200);
      await getProfile(student.username);

      const watch = watchCache();
      await student.user.agent.get(`${API_PREFIX}/student/game/profile`).expect(200);

      expect(watch.invalidate).not.toHaveBeenCalled();
      expect(watch.invalidateAll).not.toHaveBeenCalled();
    });
  });

  describe('streak sweep (non-HTTP writer)', () => {
    it('resets a lapsed streak in the public views at once, and invalidates nothing when there is nothing to reset', async () => {
      const student = await createStudent(true);
      await giveGameProfile(student.user.userId, {
        totalSolved: 2,
        streak: 5,
        lastActive: '2020-01-01',
      });
      const gamification = ctx.app.get(GamificationService);

      expect((await getProfile(student.username)).current_streak).toBe(5);
      expect(rowFor(await getLeaderboard(), student.username)?.current_streak).toBe(5);

      expect(await gamification.sweepLapsedStreaks()).toBeGreaterThanOrEqual(1);

      expect((await getProfile(student.username)).current_streak).toBe(0);
      expect(rowFor(await getLeaderboard(), student.username)?.current_streak).toBe(0);

      // A second sweep updates no row and must not evict the entries again.
      const watch = watchCache();
      expect(await gamification.sweepLapsedStreaks()).toBe(0);
      expect(watch.invalidate).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Key isolation
  // ---------------------------------------------------------------------------------------------

  describe('cache-key isolation', () => {
    it('different usernames and different leaderboard queries never share an entry', async () => {
      const first = await createStudent(true);
      const second = await createStudent(true);
      await giveGameProfile(first.user.userId, { xp: 50, totalSolved: 5 });
      await giveGameProfile(second.user.userId, { xp: 20, totalSolved: 2 });

      // Warm in an order that would expose a collision (the small page first).
      const onePerPage = await getLeaderboard('?limit=1&metric=xp');
      const wide = await getLeaderboard('?limit=25&metric=xp');
      const secondPage = await getLeaderboard('?limit=1&page=2&metric=xp');

      expect(onePerPage.rows.map((row) => row.username)).toEqual([first.username]);
      expect(wide.rows.map((row) => row.username)).toEqual([first.username, second.username]);
      expect(secondPage.rows.map((row) => row.username)).toEqual([second.username]);

      expect((await getProfile(first.username)).xp).toBe(50);
      expect((await getProfile(second.username)).xp).toBe(20);
    });
  });
});
