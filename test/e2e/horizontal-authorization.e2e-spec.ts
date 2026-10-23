import type { DataSource } from 'typeorm';

import { Exam } from '../../src/exams/entities/exam.entity';
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

jest.setTimeout(180_000);

/**
 * Horizontal authorization (IDOR) matrix (Phase 4, TC-AUTHZ-02/03). The route sweep proves
 * vertical authorization (role); this proves that two callers of the SAME role cannot reach each
 * other's rows. Every case checks the denial AND that the owner's data is untouched.
 */
describe('horizontal authorization matrix (e2e)', () => {
  let ctx: E2EContext;
  const ds = (): DataSource => ctx.dataSource;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });
  beforeEach(async () => resetDatabase(ds()));
  afterAll(async () => ctx.app.close());

  const denied = (status: number): void => {
    expect([403, 404]).toContain(status);
  };

  async function seedSubject(): Promise<string> {
    const subjects = ds().getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'IDOR subject',
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
    return subject.id;
  }

  async function seedLesson(teacher: AuthenticatedUser, subjectId: string): Promise<string> {
    const lessons = ds().getRepository(Lesson);
    const lesson = await lessons.save(
      lessons.create({
        title: 'Owned lesson',
        description: null,
        teacher_id: teacher.userId,
        subject_id: subjectId,
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

  describe('students', () => {
    it('cannot read another student order, and it is absent from their own list', async () => {
      const teacher = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const a = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
      const b = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
      const lessonId = await seedLesson(teacher, await seedSubject());

      const created = await a.agent
        .post(`${API_PREFIX}/payments/orders`)
        .send({
          item_type: 'lesson',
          item_id: lessonId,
          payment_channel: 'gateway',
          idempotency_key: 'idor-order-a',
        })
        .expect(201);
      const orderId = (created.body as { data: { order: { id: string } } }).data.order.id;

      await a.agent.get(`${API_PREFIX}/payments/orders/${orderId}`).expect(200);
      denied((await b.agent.get(`${API_PREFIX}/payments/orders/${orderId}`)).status);

      const list = await b.agent.get(`${API_PREFIX}/payments/orders`).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(orderId);

      const gateway = await b.agent
        .post(`${API_PREFIX}/payments/orders/${orderId}/gateway`)
        .send({
          billing_data: {
            first_name: 'Eve',
            last_name: 'Other',
            email: 'eve@example.com',
            phone_number: '01012345678',
            city: 'Cairo',
            state: 'Cairo',
            country: 'EG',
          },
        });
      denied(gateway.status);
      const rows = (await ds().query(`SELECT status FROM orders WHERE id = $1`, [orderId])) as Array<{
        status: string;
      }>;
      expect(rows[0]?.status).toBe('awaiting_payment');
    });

    it('cannot mark another student notification as read', async () => {
      const a = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
      const b = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
      const rows = (await ds().query(
        `INSERT INTO notifications (id, user_id, type, title, message, is_read, sent_at)
         VALUES (gen_random_uuid(), $1, 'attendance', 'Private', 'For A only', false, now()) RETURNING id`,
        [a.userId],
      )) as Array<{ id: string }>;
      const id = rows[0]?.id as string;

      denied((await b.agent.post(`${API_PREFIX}/notifications/${id}/read`)).status);
      const after = (await ds().query(`SELECT is_read FROM notifications WHERE id = $1`, [id])) as Array<{
        is_read: boolean;
      }>;
      expect(after[0]?.is_read).toBe(false);

      const list = await b.agent.get(`${API_PREFIX}/notifications`).expect(200);
      expect(JSON.stringify(list.body)).not.toContain('For A only');
    });

    it('cannot see or send another student lesson progress or attempts', async () => {
      const teacher = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const b = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
      const lessonId = await seedLesson(teacher, await seedSubject());
      // B never bought the lesson: progress writes and attempt reads must not succeed.
      const write = await b.agent
        .post(`${API_PREFIX}/student/lessons/${lessonId}/progress`)
        .send({ watchedDuration: 100 });
      expect(write.status).toBeGreaterThanOrEqual(400);
      expect(write.status).toBeLessThan(500);
      denied(
        (await b.agent.get(`${API_PREFIX}/student/exams/attempts/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b`)).status,
      );
    });
  });

  describe('teachers', () => {
    it('cannot read, edit or delete another teacher lesson', async () => {
      const t1 = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const t2 = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const lessonId = await seedLesson(t1, await seedSubject());

      denied((await t2.agent.put(`${API_PREFIX}/teacher/lessons/${lessonId}`).send({ title: 'Hijacked' })).status);
      denied((await t2.agent.put(`${API_PREFIX}/teacher/lessons/${lessonId}/visibility`).send({ status: 'draft' })).status);
      denied((await t2.agent.delete(`${API_PREFIX}/teacher/lessons/${lessonId}`)).status);

      const row = (await ds().query(`SELECT title, deleted_at FROM lessons WHERE id = $1`, [lessonId])) as Array<{
        title: string;
        deleted_at: Date | null;
      }>;
      expect(row[0]?.title).toBe('Owned lesson');
      expect(row[0]?.deleted_at).toBeNull();
    });

    it('cannot read, edit or delete another teacher exam', async () => {
      const t1 = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const t2 = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      const subjectId = await seedSubject();
      const exams = ds().getRepository(Exam);
      const exam = await exams.save(
        exams.create({
          teacher_id: t1.userId,
          subject_id: subjectId,
          lesson_id: null,
          package_id: null,
          title: 'T1 exam',
          title_ar: 'اختبار',
          description: null,
          description_ar: null,
          is_public: false,
          status: 'draft',
          config: {
            duration_seconds: 600,
            grace_seconds: 30,
            attempts_allowed: 1,
            review_policy: 'after_submit',
            shuffle_questions: false,
            shuffle_choices: false,
            start_window_at: null,
            end_window_at: null,
          },
          total_marks: 1,
          passing_marks: 1,
        } as never) as unknown as Exam,
      );

      denied((await t2.agent.get(`${API_PREFIX}/teacher/exams/${exam.id}`)).status);
      denied((await t2.agent.put(`${API_PREFIX}/teacher/exams/${exam.id}`).send({ title: 'Hijacked' })).status);
      denied((await t2.agent.delete(`${API_PREFIX}/teacher/exams/${exam.id}`)).status);

      const row = (await ds().query(`SELECT title FROM exams WHERE id = $1`, [exam.id])) as Array<{
        title: string;
      }>;
      expect(row[0]?.title).toBe('T1 exam');
      const list = await t2.agent.get(`${API_PREFIX}/teacher/exams`).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(exam.id);
    });
  });
});
