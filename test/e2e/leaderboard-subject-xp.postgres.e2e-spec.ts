import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

/**
 * T097 / W1-C6(e): the all-time SUBJECT leaderboard computes each student's subject XP once per row.
 * Parity fixture: ties, a student with a rating row but no solve rows (XP 0), solves in another
 * subject that must not leak in, a private profile that must be excluded, and `solved = 0`.
 * The expected boards below were captured from the pre-rewrite query.
 */
describe('subject leaderboard parity (T097)', () => {
  let ctx: E2EContext;
  const server = (): Server => ctx.app.getHttpServer() as Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  async function student(isPublic: boolean): Promise<{ id: string; username: string }> {
    const user = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'student' });
    await ctx.dataSource.query(
      `INSERT INTO student_profiles (id, user_id, is_public_profile) VALUES (gen_random_uuid(), $1, $2)
       ON CONFLICT DO NOTHING`,
      [user.userId, isPublic],
    );
    await ctx.dataSource.query(
      `UPDATE student_profiles SET is_public_profile = $2 WHERE user_id = $1`,
      [user.userId, isPublic],
    );
    await ctx.dataSource.query(
      `INSERT INTO student_game_profiles (id, user_id, xp, total_solved, current_streak) VALUES (gen_random_uuid(), $1, 1000, 5, 0)`,
      [user.userId],
    );
    const [{ username }] = (await ctx.dataSource.query(`SELECT username FROM users WHERE id = $1`, [
      user.userId,
    ])) as [{ username: string }];
    return { id: user.userId, username };
  }

  async function rating(
    userId: string,
    subjectId: string,
    value: number,
    solved: number,
  ): Promise<void> {
    await ctx.dataSource.query(
      `INSERT INTO student_subject_ratings (id, user_id, subject_id, rating, solved) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
      [userId, subjectId, value, solved],
    );
  }

  async function solve(
    teacherId: string,
    userId: string,
    subjectId: string,
    xp: number,
  ): Promise<void> {
    const questionId = randomUUID();
    await ctx.dataSource.query(
      `INSERT INTO questions (id, teacher_id, subject_id, type, content, answer_key, default_marks, is_public, is_active)
       VALUES ($1, $2, $3, 'single_choice', '{}'::jsonb, '{}'::jsonb, 1, true, true)`,
      [questionId, teacherId, subjectId],
    );
    await ctx.dataSource.query(
      `INSERT INTO question_solves (id, user_id, question_id, question_version, subject_id, difficulty, is_correct, xp_awarded)
       VALUES (gen_random_uuid(), $1, $2, 1, $3, 'easy', true, $4)`,
      [userId, questionId, subjectId, xp],
    );
  }

  async function board(
    subjectId: string,
    metric: 'xp' | 'rating',
  ): Promise<Array<{ username: string; xp: number; rating: number; attempts: number }>> {
    const res = await request(server())
      .get(`${API_PREFIX}/leaderboard`)
      .query({ scope: 'subject', subject_id: subjectId, metric })
      .expect(200);
    return (
      res.body as {
        rows: Array<{ username: string; xp: number; rating: number; attempts: number }>;
      }
    ).rows;
  }

  it('orders and scores the subject board identically for both metrics', async () => {
    const [{ id: subjectId }] = (await ctx.dataSource.query(
      `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'LB Math') RETURNING id`,
    )) as [{ id: string }];
    const [{ id: otherSubject }] = (await ctx.dataSource.query(
      `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'LB Other') RETURNING id`,
    )) as [{ id: string }];
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'teacher',
      overrides: { requestedRole: 'teacher' },
    });

    const a = await student(true);
    const b = await student(true);
    const c = await student(true);
    const d = await student(true);
    const hidden = await student(false);
    const zero = await student(true);

    await rating(a.id, subjectId, 1300, 3);
    await rating(b.id, subjectId, 1300, 2); // tie with a on rating
    await rating(c.id, subjectId, 1250, 4); // rating row but no solve rows -> XP 0
    await rating(d.id, subjectId, 1400, 1);
    await rating(hidden.id, subjectId, 1500, 9); // private profile -> excluded
    await rating(zero.id, subjectId, 1600, 0); // solved = 0 -> excluded

    await solve(teacher.userId, a.id, subjectId, 20);
    await solve(teacher.userId, a.id, subjectId, 30); // a: 50
    await solve(teacher.userId, b.id, subjectId, 50); // b: 50 (tie with a)
    await solve(teacher.userId, d.id, subjectId, 10);
    await solve(teacher.userId, d.id, otherSubject, 999); // other subject must not leak
    await solve(teacher.userId, hidden.id, subjectId, 500);

    const byXp = await board(subjectId, 'xp');
    const byRating = await board(subjectId, 'rating');

    const expectedXp = [
      [a.username, 50],
      [b.username, 50],
      [d.username, 10],
      [c.username, 0],
    ];
    // Ties are broken by user id ascending (the query's secondary order).
    const tieOrder = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1)).map((s) => s.username);
    expect(byXp.map((r) => r.username)).toEqual([...tieOrder, d.username, c.username]);
    expect(byXp.map((r) => r.xp)).toEqual([50, 50, 10, 0]);
    expect(byXp).toHaveLength(expectedXp.length);

    const ratingTies = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1)).map((s) => s.username);
    expect(byRating.map((r) => r.username)).toEqual([d.username, ...ratingTies, c.username]);
    expect(byRating.map((r) => r.xp)).toEqual([
      10,
      ...[a, b].sort((x, y) => (x.id < y.id ? -1 : 1)).map(() => 50),
      0,
    ]);
    expect(byRating.map((r) => r.attempts)).toEqual([
      1,
      ...[a, b].sort((x, y) => (x.id < y.id ? -1 : 1)).map((s) => (s.id === a.id ? 3 : 2)),
      4,
    ]);
  });
});
