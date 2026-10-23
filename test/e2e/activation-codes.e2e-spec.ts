import type { DataSource } from 'typeorm';

import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';

jest.setTimeout(120_000);

/**
 * Activation (sales) codes over HTTP against Postgres (Phase 4; was 0% e2e reach).
 * TC-ACT-02 verify and redeem grant access, TC-ACT-03 concurrent redemption is single-winner,
 * TC-ACT-04 expired / deactivated / unknown codes grant nothing, plus the role boundaries.
 */
describe('activation codes (e2e)', () => {
  let ctx: E2EContext;
  const ds = (): DataSource => ctx.dataSource;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });
  beforeEach(async () => resetDatabase(ds()));
  afterAll(async () => ctx.app.close());

  async function seedLesson(): Promise<string> {
    const teacher = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
    const subjects = ds().getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'Code subject',
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
    const lessons = ds().getRepository(Lesson);
    const lesson = await lessons.save(
      lessons.create({
        title: 'Code lesson',
        description: null,
        teacher_id: teacher.userId,
        subject_id: subject.id,
        thumbnail: null,
        price: 100,
        duration: 600,
        is_group: true,
        available_for_days: 30,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    return lesson.id;
  }

  async function generate(admin: AuthenticatedUser, lessonId: string, count = 1): Promise<string[]> {
    const res = await admin.agent
      .post(`${API_PREFIX}/admin/attendance-codes/generate`)
      .send({
        type: 'lesson',
        item_id: lessonId,
        count,
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      })
      .expect(201);
    return (res.body as { data: Array<{ code: string }> }).data.map((c) => c.code);
  }

  const redeem = (user: AuthenticatedUser, code: string) =>
    user.agent.post(`${API_PREFIX}/attendance-codes/redeem`).send({ code });

  async function lessonPurchases(studentId: string, lessonId: string): Promise<number> {
    const rows = (await ds().query(
      `SELECT COUNT(*)::int AS count FROM lesson_purchases WHERE student_id = $1 AND lesson_id = $2`,
      [studentId, lessonId],
    )) as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }

  it('only admins can generate codes and only students can redeem them', async () => {
    const student = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const teacher = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
    const lessonId = await seedLesson();
    const body = {
      type: 'lesson',
      item_id: lessonId,
      count: 1,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    };
    await student.agent.post(`${API_PREFIX}/admin/attendance-codes/generate`).send(body).expect(403);
    await teacher.agent.post(`${API_PREFIX}/admin/attendance-codes/generate`).send(body).expect(403);

    const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });
    const [code] = await generate(admin, lessonId);
    await redeem(teacher, code as string).expect(403);
  });

  it('verify previews the item without consuming; redeem then grants access exactly once', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });
    const student = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const lessonId = await seedLesson();
    const [code] = await generate(admin, lessonId);

    const verify = await student.agent
      .post(`${API_PREFIX}/attendance-codes/verify`)
      .send({ code })
      .expect(201);
    expect(verify.body.data).toMatchObject({ valid: true, itemId: lessonId, isUsed: false });
    expect(await lessonPurchases(student.userId, lessonId)).toBe(0);

    const res = await redeem(student, code as string);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ item_type: 'lesson', item_id: lessonId });
    expect(await lessonPurchases(student.userId, lessonId)).toBe(1);

    const again = await redeem(student, code as string);
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
    expect(await lessonPurchases(student.userId, lessonId)).toBe(1);
  });

  it('single-winner: two students redeeming one code at once yield one grant and one 4xx', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });
    const a = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const b = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const lessonId = await seedLesson();
    const [code] = await generate(admin, lessonId);

    const [ra, rb] = await Promise.all([redeem(a, code as string), redeem(b, code as string)]);
    const statuses = [ra.status, rb.status].sort((x, y) => x - y);
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
    expect(statuses[1]).toBeLessThan(500);
    const total = (await lessonPurchases(a.userId, lessonId)) + (await lessonPurchases(b.userId, lessonId));
    expect(total).toBe(1);
  });

  it('grants nothing for an expired, deactivated or unknown code', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });
    const student = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const lessonId = await seedLesson();
    const [expired, deactivated] = await generate(admin, lessonId, 2);

    await ds().query(`UPDATE attendance_codes SET expires_at = now() - interval '1 day' WHERE code = $1`, [
      expired,
    ]);
    await admin.agent
      .post(`${API_PREFIX}/admin/attendance-codes/${deactivated as string}/deactivate`)
      .send({})
      .expect(201);

    for (const code of [expired, deactivated, 'ZZZZZZZZZZZZ']) {
      const res = await redeem(student, code as string);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(await lessonPurchases(student.userId, lessonId)).toBe(0);
  });
});
