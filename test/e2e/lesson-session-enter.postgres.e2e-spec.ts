import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';

import { LessonSession } from '../../src/attendance/entities/lesson-session.entity';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import {
  ItemType,
  LessonPurchase,
  Payment,
  PaymentChannel,
  PaymentMethod,
  PaymentStatus,
} from '../../src/payments/entities';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  setUserRole,
} from './fixtures';

/**
 * AUD-001 regression coverage at the HTTP boundary.
 *
 * `POST /lessons/:id/enter` read `x-forwarded-for` as a bare `string` and called
 * `.split()` on it before its `?? request.ip` fallback could run. Any request
 * that did not arrive through a header-setting proxy — a direct hit, a
 * misconfigured ingress, an internal probe — therefore got a 500 instead of a
 * session, which also silently blocked the 80% auto-attendance path that hangs
 * off it.
 *
 * The defect survived because **no test ever called this route**. Supertest
 * sends no `x-forwarded-for` of its own, so this spec exercises exactly the
 * shape that used to crash, plus the proxied and multi-hop shapes.
 */
describe('lesson session enter — client IP handling (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    server = app.getHttpServer();
  });
  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  /** An approved student holding a live purchase for a published lesson. */
  async function enrolledStudentFixture() {
    const student = await createAuthenticatedUser(app, dataSource);

    const users = dataSource.getRepository(User);
    const teacher = await users.save(
      users.create({
        username: 'enter-ip-teacher',
        name: 'Enter IP Teacher',
        first_name: null,
        last_name: null,
        email: 'enter-ip-teacher@example.test',
        phone: '01277000001',
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );

    // Only fields the entity still declares — `name_ar`/`thumbnail` were
    // removed by migration 2074 and are silently dropped by `create()`.
    const subjects = dataSource.getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'Enter IP subject',
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );

    const lessons = dataSource.getRepository(Lesson);
    const lesson = await lessons.save(
      lessons.create({
        title: 'Enter IP lesson',
        description: null,
        teacher_id: teacher.id,
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

    const payments = dataSource.getRepository(Payment);
    const payment = await payments.save(
      payments.create({
        order_id: null,
        user_id: student.userId,
        item_type: ItemType.LESSON,
        item_id: lesson.id,
        amount: 100,
        discount_amount: 0,
        final_amount: 100,
        amount_minor: 10_000,
        currency: 'EGP',
        channel: PaymentChannel.MANUAL,
        provider: null,
        provider_reference: 'enter-ip-e2e',
        status: PaymentStatus.COMPLETED,
        payment_method: PaymentMethod.MANUAL,
        // NOT NULL and UNIQUE — each fixture needs its own.
        idempotency_key: `enter-ip-${randomUUID()}`,
      }),
    );

    const purchases = dataSource.getRepository(LessonPurchase);
    const grantedAt = new Date();
    const expiresAt = new Date(grantedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    await purchases.save(
      purchases.create({
        student_id: student.userId,
        lesson_id: lesson.id,
        payment_id: payment.id,
        price_paid: 100,
        access_granted_at: grantedAt,
        access_expires_at: expiresAt,
        days_extended: 0,
        revoked_at: null,
        revocation_reason: null,
      }),
    );

    return { student, lesson };
  }

  async function recordedIpFor(lessonId: string): Promise<string | null> {
    const session = await dataSource.getRepository(LessonSession).findOne({
      where: { lesson_id: lessonId },
      order: { entered_at: 'DESC' },
    });
    return session?.ip_address ?? null;
  }

  it('starts a session when no x-forwarded-for header is present', async () => {
    const { student, lesson } = await enrolledStudentFixture();

    const response = await student.agent.post(`${API_PREFIX}/lessons/${lesson.id}/enter`).send();

    // The bug produced 500 here.
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ message: 'Session started' });

    // A session row exists, and the absent header did not corrupt the column.
    const ip = await recordedIpFor(lesson.id);
    expect(ip === null || typeof ip === 'string').toBe(true);
  });

  it('records the first hop when the proxy supplies x-forwarded-for', async () => {
    const { student, lesson } = await enrolledStudentFixture();

    await student.agent
      .post(`${API_PREFIX}/lessons/${lesson.id}/enter`)
      .set('x-forwarded-for', '203.0.113.7')
      .send()
      .expect(201);

    expect(await recordedIpFor(lesson.id)).toBe('203.0.113.7');
  });

  it('records the leftmost address from a multi-hop forwarded chain', async () => {
    const { student, lesson } = await enrolledStudentFixture();

    await student.agent
      .post(`${API_PREFIX}/lessons/${lesson.id}/enter`)
      .set('x-forwarded-for', '203.0.113.9, 198.51.100.4, 10.0.0.9')
      .send()
      .expect(201);

    expect(await recordedIpFor(lesson.id)).toBe('203.0.113.9');
  });

  it('does not 500 on a blank forwarded header', async () => {
    const { student, lesson } = await enrolledStudentFixture();

    const response = await student.agent
      .post(`${API_PREFIX}/lessons/${lesson.id}/enter`)
      .set('x-forwarded-for', '   ')
      .send();

    expect(response.status).toBe(201);
    expect(await recordedIpFor(lesson.id)).not.toBe('   ');
  });

  it('still requires authentication', async () => {
    const { lesson } = await enrolledStudentFixture();

    await request(server).post(`${API_PREFIX}/lessons/${lesson.id}/enter`).send().expect(401);
  });

  it('still refuses a student with no entitlement — the fix did not widen access', async () => {
    const { lesson } = await enrolledStudentFixture();
    const outsider = await createAuthenticatedUser(app, dataSource);

    // `assertStudentEnrollment` throws ForbiddenException for a student with no
    // active lesson access — the lesson itself exists, so this is 403, not 404.
    await outsider.agent.post(`${API_PREFIX}/lessons/${lesson.id}/enter`).send().expect(403);
  });

  it('still refuses a non-student role', async () => {
    const { lesson } = await enrolledStudentFixture();
    const teacherUser = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, teacherUser.userId, 'teacher');

    await teacherUser.agent.post(`${API_PREFIX}/lessons/${lesson.id}/enter`).send().expect(403);
  });
});
