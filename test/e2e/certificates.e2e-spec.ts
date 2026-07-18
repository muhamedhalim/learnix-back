import type { Server } from 'node:http';

import type { DataSource } from 'typeorm';

import request from 'supertest';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';

/**
 * Certificate system E2E: template lifecycle (draft → publish → issue),
 * issuance permissions, snapshot immutability, revocation, and the public
 * gallery/verification surface — all against the real app + database.
 */
describe('Certificates (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  /** Minimal complete course: subject → lesson → package(+item) for a teacher. */
  async function seedCourse(
    dataSource: DataSource,
    teacherId: string,
  ): Promise<{ packageId: string; lessonId: string }> {
    const [{ id: subjectId }] = (await dataSource.query(
      `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'E2E Subject') RETURNING id`,
    )) as [{ id: string }];
    const [{ id: lessonId }] = (await dataSource.query(
      `INSERT INTO lessons (id, title, title_ar, teacher_id, subject_id, price)
       VALUES (gen_random_uuid(), 'E2E Lesson', 'درس', $1, $2, 0) RETURNING id`,
      [teacherId, subjectId],
    )) as [{ id: string }];
    const [{ id: packageId }] = (await dataSource.query(
      `INSERT INTO lesson_packages (id, title, title_ar, teacher_id, price)
       VALUES (gen_random_uuid(), 'E2E Course', 'كورس', $1, 0) RETURNING id`,
      [teacherId],
    )) as [{ id: string }];
    await dataSource.query(
      `INSERT INTO lesson_package_items (id, package_id, lesson_id) VALUES (gen_random_uuid(), $1, $2)`,
      [packageId, lessonId],
    );
    return { packageId, lessonId };
  }

  /** Enroll a student and mark the whole course complete. */
  async function completeCourse(
    dataSource: DataSource,
    studentId: string,
    packageId: string,
    lessonId: string,
  ): Promise<void> {
    const [{ id: paymentId }] = (await dataSource.query(
      `INSERT INTO payments (id, user_id, item_type, item_id, amount, discount_amount, final_amount, payment_method, status, idempotency_key)
       VALUES (gen_random_uuid(), $1, 'package', $2, 0, 0, 0, 'purchase_code', 'completed', $3) RETURNING id`,
      [studentId, packageId, `e2e-cert-${studentId}-${Date.now()}`],
    )) as [{ id: string }];
    await dataSource.query(
      `INSERT INTO package_purchases (id, student_id, package_id, payment_id, price_paid, purchased_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 0, now())`,
      [studentId, packageId, paymentId],
    );
    await dataSource.query(
      `INSERT INTO lesson_progress (id, student_id, lesson_id, watched_duration, total_duration, progress_percent, completed, last_watched_at)
       VALUES (gen_random_uuid(), $1, $2, 600, 600, 100, true, now())`,
      [studentId, lessonId],
    );
  }

  async function publishedTemplate(admin: AuthenticatedUser): Promise<string> {
    const created = await admin.agent
      .post(`${API_PREFIX}/admin/certificates/templates`)
      .send({ name: 'E2E Design', title: 'Certificate of Completion', body: 'For {{student}}' })
      .expect(201);
    const templateId = created.body.id as string;
    await admin.agent
      .post(`${API_PREFIX}/admin/certificates/templates/${templateId}/publish`)
      .expect(201);
    return templateId;
  }

  describe('template lifecycle', () => {
    it('creates as a draft, refuses issuance until published, then allows it', async () => {
      const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
      const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        overrides: { requestedRole: 'teacher' },
        role: 'teacher',
      });
      const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const { packageId, lessonId } = await seedCourse(ctx.dataSource, teacher.userId);
      await completeCourse(ctx.dataSource, student.userId, packageId, lessonId);

      const created = await admin.agent
        .post(`${API_PREFIX}/admin/certificates/templates`)
        .send({ name: 'Draft Design', title: 'Title', body: 'Body {{student}}' })
        .expect(201);
      expect(created.body.status).toBe('draft');
      const templateId = created.body.id as string;

      // Draft templates are unusable for issuance.
      await admin.agent
        .post(`${API_PREFIX}/admin/certificates/issue`)
        .send({ packageId, studentIds: [student.userId], templateId })
        .expect(400);

      await admin.agent
        .post(`${API_PREFIX}/admin/certificates/templates/${templateId}/publish`)
        .expect(201);

      const issue = await admin.agent
        .post(`${API_PREFIX}/admin/certificates/issue`)
        .send({ packageId, studentIds: [student.userId], templateId })
        .expect(201);
      expect(issue.body).toMatchObject({ requested: 1, issued: 1, skipped: 0 });
    });

    it('publish validates required fields', async () => {
      const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
      const created = await admin.agent
        .post(`${API_PREFIX}/admin/certificates/templates`)
        .send({ name: 'Incomplete', title: '', body: '' })
        .expect(201);
      await admin.agent
        .post(`${API_PREFIX}/admin/certificates/templates/${created.body.id}/publish`)
        .expect(400);
    });

    it("a teacher cannot read or edit another teacher's template", async () => {
      const teacherA = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        overrides: { requestedRole: 'teacher' },
        role: 'teacher',
      });
      const teacherB = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        overrides: { requestedRole: 'teacher' },
        role: 'teacher',
      });
      const created = await teacherA.agent
        .post(`${API_PREFIX}/teacher/certificates/templates`)
        .send({ name: 'Mine', title: 'T', body: 'B' })
        .expect(201);

      await teacherB.agent
        .get(`${API_PREFIX}/teacher/certificates/templates/${created.body.id}`)
        .expect(404);
      await teacherB.agent
        .patch(`${API_PREFIX}/teacher/certificates/templates/${created.body.id}`)
        .send({ title: 'Hijacked' })
        .expect(404);
    });
  });

  describe('issuance', () => {
    it('skips duplicates instead of double-issuing', async () => {
      const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
      const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        overrides: { requestedRole: 'teacher' },
        role: 'teacher',
      });
      const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const { packageId, lessonId } = await seedCourse(ctx.dataSource, teacher.userId);
      await completeCourse(ctx.dataSource, student.userId, packageId, lessonId);
      const templateId = await publishedTemplate(admin);

      const first = await admin.agent
        .post(`${API_PREFIX}/admin/certificates/issue`)
        .send({ packageId, studentIds: [student.userId], templateId })
        .expect(201);
      expect(first.body.issued).toBe(1);

      const second = await admin.agent
        .post(`${API_PREFIX}/admin/certificates/issue`)
        .send({ packageId, studentIds: [student.userId], templateId })
        .expect(201);
      expect(second.body).toMatchObject({ issued: 0, skipped: 1 });
    });

    it("a teacher cannot issue for another teacher's course", async () => {
      const teacherA = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        overrides: { requestedRole: 'teacher' },
        role: 'teacher',
      });
      const teacherB = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        overrides: { requestedRole: 'teacher' },
        role: 'teacher',
      });
      const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const { packageId } = await seedCourse(ctx.dataSource, teacherA.userId);

      await teacherB.agent
        .post(`${API_PREFIX}/teacher/certificates/issue`)
        .send({ packageId, studentIds: [student.userId], force: true })
        .expect(403);
    });

    it('the snapshot survives template edits (old certificates never restyle)', async () => {
      const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
      const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        overrides: { requestedRole: 'teacher' },
        role: 'teacher',
      });
      const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const { packageId, lessonId } = await seedCourse(ctx.dataSource, teacher.userId);
      await completeCourse(ctx.dataSource, student.userId, packageId, lessonId);
      const templateId = await publishedTemplate(admin);

      await admin.agent
        .post(`${API_PREFIX}/admin/certificates/issue`)
        .send({ packageId, studentIds: [student.userId], templateId })
        .expect(201);

      await admin.agent
        .patch(`${API_PREFIX}/admin/certificates/templates/${templateId}`)
        .send({ title: 'A COMPLETELY DIFFERENT TITLE' })
        .expect(200);

      const [row] = (await ctx.dataSource.query(
        `SELECT template_snapshot FROM certificates WHERE student_id = $1`,
        [student.userId],
      )) as [{ template_snapshot: { title: string } }];
      expect(row.template_snapshot.title).toBe('Certificate of Completion');
    });

    it('creates an in-app notification for the student', async () => {
      const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
      const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        overrides: { requestedRole: 'teacher' },
        role: 'teacher',
      });
      const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const { packageId, lessonId } = await seedCourse(ctx.dataSource, teacher.userId);
      await completeCourse(ctx.dataSource, student.userId, packageId, lessonId);
      const templateId = await publishedTemplate(admin);

      await admin.agent
        .post(`${API_PREFIX}/admin/certificates/issue`)
        .send({ packageId, studentIds: [student.userId], templateId })
        .expect(201);

      // The listener fires async off the event bus — give it a beat.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const rows = (await ctx.dataSource.query(
        `SELECT title FROM notifications WHERE user_id = $1`,
        [student.userId],
      )) as { title: string }[];
      expect(rows.some((r) => r.title.toLowerCase().includes('certificate'))).toBe(true);
    });
  });

  describe('student surface + public gallery + verification', () => {
    it('runs the full journey: issue → student sees it → publish → gallery → verify → revoke → gone', async () => {
      const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
      const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        overrides: { requestedRole: 'teacher' },
        role: 'teacher',
      });
      const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const { packageId, lessonId } = await seedCourse(ctx.dataSource, teacher.userId);
      await completeCourse(ctx.dataSource, student.userId, packageId, lessonId);
      const templateId = await publishedTemplate(admin);

      await admin.agent
        .post(`${API_PREFIX}/admin/certificates/issue`)
        .send({ packageId, studentIds: [student.userId], templateId })
        .expect(201);

      // Student sees their certificate (private by default).
      const mine = await student.agent.get(`${API_PREFIX}/student/certificates`).expect(200);
      expect(mine.body.data).toHaveLength(1);
      const cert = mine.body.data[0] as {
        id: string;
        verification_code: string;
        is_public: boolean;
      };
      expect(cert.is_public).toBe(false);

      // Private → the anonymous gallery is empty.
      const emptyGallery = await request(server)
        .get(`${API_PREFIX}/certificates/public`)
        .expect(200);
      expect(emptyGallery.body.data).toHaveLength(0);

      // Student publishes it.
      await student.agent
        .patch(`${API_PREFIX}/student/certificates/${cert.id}/visibility`)
        .send({ is_public: true })
        .expect(200);

      // Now the anonymous gallery shows a sanitized card.
      const gallery = await request(server).get(`${API_PREFIX}/certificates/public`).expect(200);
      expect(gallery.body.data).toHaveLength(1);
      const card = gallery.body.data[0] as Record<string, unknown>;
      expect(card.publicId).toBe(cert.verification_code);
      expect(card).not.toHaveProperty('id');
      expect(card).not.toHaveProperty('student_id');
      expect(card).not.toHaveProperty('completion_percentage');

      // Anonymous verification works, and the PDF downloads.
      const verify = await request(server)
        .get(`${API_PREFIX}/certificates/verify/${cert.verification_code}`)
        .expect(200);
      expect(verify.body.valid).toBe(true);
      const pdf = await request(server)
        .get(`${API_PREFIX}/certificates/verify/${cert.verification_code}/pdf`)
        .expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');

      // Revoke → gallery empties immediately, verification flips to invalid.
      await admin.agent
        .post(`${API_PREFIX}/admin/certificates/${cert.id}/revoke`)
        .send({ reason: 'e2e' })
        .expect(201);
      const revokedGallery = await request(server)
        .get(`${API_PREFIX}/certificates/public`)
        .expect(200);
      expect(revokedGallery.body.data).toHaveLength(0);
      const revokedVerify = await request(server)
        .get(`${API_PREFIX}/certificates/verify/${cert.verification_code}`)
        .expect(200);
      expect(revokedVerify.body.valid).toBe(false);

      // Reissue → fresh credentials; the old code is dead, the new one verifies.
      const reissued = await admin.agent
        .post(`${API_PREFIX}/admin/certificates/${cert.id}/reissue`)
        .expect(201);
      const newCode = reissued.body.verification_code as string;
      expect(newCode).not.toBe(cert.verification_code);
      await request(server)
        .get(`${API_PREFIX}/certificates/verify/${cert.verification_code}`)
        .expect(404);
      const newVerify = await request(server)
        .get(`${API_PREFIX}/certificates/verify/${newCode}`)
        .expect(200);
      expect(newVerify.body.valid).toBe(true);
    });

    it('an invalid verification code reveals nothing', async () => {
      const res = await request(server)
        .get(`${API_PREFIX}/certificates/verify/NOPE123456`)
        .expect(404);
      expect(JSON.stringify(res.body)).not.toContain('student');
    });

    it("a student cannot toggle another student's certificate", async () => {
      const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
      const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
        overrides: { requestedRole: 'teacher' },
        role: 'teacher',
      });
      const owner = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const intruder = await createAuthenticatedUser(ctx.app, ctx.dataSource);
      const { packageId, lessonId } = await seedCourse(ctx.dataSource, teacher.userId);
      await completeCourse(ctx.dataSource, owner.userId, packageId, lessonId);
      const templateId = await publishedTemplate(admin);
      await admin.agent
        .post(`${API_PREFIX}/admin/certificates/issue`)
        .send({ packageId, studentIds: [owner.userId], templateId })
        .expect(201);
      const mine = await owner.agent.get(`${API_PREFIX}/student/certificates`).expect(200);
      const certId = mine.body.data[0].id as string;

      await intruder.agent
        .patch(`${API_PREFIX}/student/certificates/${certId}/visibility`)
        .send({ is_public: true })
        .expect(404);
    });
  });
});
