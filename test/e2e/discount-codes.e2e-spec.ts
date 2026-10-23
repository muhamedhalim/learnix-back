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
 * Discount codes over HTTP against Postgres (Phase 4; was 0% e2e reach).
 * TC-DSC-01 rounding (F-12), -02 global limit under concurrency, -03 per-user limit,
 * -05 targeting/minimum, plus the admin-only boundary.
 */
describe('discount codes (e2e)', () => {
  let ctx: E2EContext;
  const ds = (): DataSource => ctx.dataSource;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });
  beforeEach(async () => resetDatabase(ds()));
  afterAll(async () => ctx.app.close());

  async function seedLesson(price: number): Promise<{ lessonId: string }> {
    const teacher = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
    const subjects = ds().getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'Discount subject',
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
        title: 'Discount lesson',
        description: null,
        teacher_id: teacher.userId,
        subject_id: subject.id,
        thumbnail: null,
        price,
        duration: 600,
        is_group: true,
        available_for_days: 30,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    return { lessonId: lesson.id };
  }

  async function createCode(admin: AuthenticatedUser, body: Record<string, unknown>): Promise<void> {
    await admin.agent
      .post(`${API_PREFIX}/admin/discount-codes`)
      .send({ discount_type: 'percentage', applicable_to: ['lesson'], ...body })
      .expect(201);
  }

  const quote = (user: AuthenticatedUser, lessonId: string, code: string) =>
    user.agent
      .post(`${API_PREFIX}/payments/checkout/quote`)
      .send({ item_type: 'lesson', item_id: lessonId, discount_code: code });

  const order = (user: AuthenticatedUser, lessonId: string, code: string, key: string) =>
    user.agent.post(`${API_PREFIX}/payments/orders`).send({
      item_type: 'lesson',
      item_id: lessonId,
      payment_channel: 'gateway',
      discount_code: code,
      idempotency_key: key,
    });

  it('is admin-only to create; a student gets 403', async () => {
    const student = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    await student.agent
      .post(`${API_PREFIX}/admin/discount-codes`)
      .send({
        code: 'NOPE',
        discount_type: 'percentage',
        discount_value: 10,
        applicable_to: ['lesson'],
      })
      .expect(403);
  });

  it.each([
    { percent: 12.5, price: 99, discount: 12.38, final: 86.62 },
    { percent: 10, price: 19.9, discount: 1.99, final: 17.91 },
    { percent: 33.33, price: 150, discount: 50, final: 100 },
  ])('F-12: $percent% off $price EGP rounds to whole piastres and still quotes', async (c) => {
    const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });
    const student = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const { lessonId } = await seedLesson(c.price);
    await createCode(admin, { code: 'ROUND', discount_value: c.percent });

    const verify = await student.agent
      .post(`${API_PREFIX}/discount-codes/verify`)
      .send({ code: 'ROUND', item_type: 'lesson', item_id: lessonId, amount: c.price })
      .expect(200);
    expect(verify.body.valid).toBe(true);
    expect(verify.body.discount_amount).toBeCloseTo(c.discount, 2);
    expect(verify.body.final_amount).toBeCloseTo(c.final, 2);

    const res = await quote(student, lessonId, 'ROUND');
    expect(res.status).toBe(201);
    const pricing = (res.body as { data: { pricing: Record<string, number> } }).data.pricing;
    expect(pricing['discount_amount_minor']).toBe(Math.round(c.discount * 100));
    expect(pricing['final_amount_minor']).toBe(Math.round(c.final * 100));
  });

  it('applies a global max_uses limit exactly under concurrent orders', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });
    const { lessonId } = await seedLesson(100);
    await createCode(admin, { code: 'TWICE', discount_value: 10, max_uses: 2 });
    const students = await Promise.all(
      [1, 2, 3, 4].map(() => createAuthenticatedUser(ctx.app, ds(), { role: 'student' })),
    );

    const results = await Promise.all(
      students.map((s, i) => order(s, lessonId, 'TWICE', `idem-global-${String(i)}`)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    const rows = (await ds().query(`SELECT COUNT(*)::int AS count FROM discount_code_usage`)) as Array<{
      count: number;
    }>;
    expect(rows[0]?.count).toBe(2);
  });

  it('enforces max_uses_per_user: the same student cannot reserve the code twice', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });
    const student = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const first = await seedLesson(100);
    const second = await seedLesson(100);
    await createCode(admin, { code: 'ONCE', discount_value: 10, max_uses_per_user: 1 });

    await order(student, first.lessonId, 'ONCE', 'idem-user-1').expect(201);
    const again = await order(student, second.lessonId, 'ONCE', 'idem-user-2');
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
  });

  it('rejects a code below its minimum purchase and a code for another item type', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });
    const student = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const { lessonId } = await seedLesson(50);
    await createCode(admin, { code: 'MIN100', discount_value: 10, min_purchase_amount: 100 });
    await createCode(admin, { code: 'BOOKS', discount_value: 10, applicable_to: ['book'] });

    for (const code of ['MIN100', 'BOOKS']) {
      const verify = await student.agent
        .post(`${API_PREFIX}/discount-codes/verify`)
        .send({ code, item_type: 'lesson', item_id: lessonId, amount: 50 })
        .expect(200);
      expect(verify.body.valid).toBe(false);
    }
  });

  it('answers an unknown code with a uniform invalid result (no enumeration signal)', async () => {
    const student = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const { lessonId } = await seedLesson(50);
    const verify = await student.agent
      .post(`${API_PREFIX}/discount-codes/verify`)
      .send({ code: 'DOES-NOT-EXIST', item_type: 'lesson', item_id: lessonId, amount: 50 })
      .expect(200);
    expect(verify.body.valid).toBe(false);
  });
});
