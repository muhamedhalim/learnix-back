import type { Server } from 'node:http';

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
 * Teacher-managed subjects: ownership, IDOR, and the approval lifecycle.
 *
 * The invariants under test:
 *   - a pending subject is visible only to its author (and admins);
 *   - another teacher gets 404 for a pending subject and 403 for an approved
 *     one they do not own — 403 on a pending row would enumerate drafts;
 *   - a teacher cannot attach another teacher's pending subject to content;
 *   - suspending a subject never breaks editing the content already on it;
 *   - a referenced subject cannot be deleted.
 */
describe('Subject ownership and approval (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  let admin: AuthenticatedUser;
  let teacherA: AuthenticatedUser;
  let teacherB: AuthenticatedUser;
  let student: AuthenticatedUser;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  // Users are created after the reset, not in beforeAll — resetDatabase would
  // otherwise wipe the accounts between tests.
  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    teacherA = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'teacher',
      overrides: { requestedRole: 'teacher' },
    });
    teacherB = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'teacher',
      overrides: { requestedRole: 'teacher' },
    });
    student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
  });

  afterAll(async () => ctx.app.close());

  /** Submit a subject as a teacher and return its id. */
  async function createTeacherSubject(
    teacher: AuthenticatedUser,
    name: string,
  ): Promise<{ id: string; status: string }> {
    // JSON, not multipart. `POST /teacher/subjects` takes `CreateSubjectDto`
    // through `@Body()` and has no file interceptor — subjects lost their
    // thumbnail in migration 2074 (UnifySubjectNameAndRemoveThumbnail), which
    // is when this endpoint stopped accepting a form upload. A `.field()` call
    // sends multipart, leaving `name` unparsed, so ValidationPipe answered 400.
    // The rest of this spec was already migrated to `.send()`; these two call
    // sites were missed.
    const res = await teacher.agent
      .post(`${API_PREFIX}/teacher/subjects`)
      .send({ name })
      .expect(201);
    const body = res.body as { subject: { id: string; status: string } };
    return body.subject;
  }

  /** Ids present in a paginated subject listing. */
  function idsOf(body: unknown): string[] {
    const rows = (body as { data?: { id: string }[] }).data ?? [];
    return rows.map((row) => row.id);
  }

  describe('creation and visibility', () => {
    it('creates a teacher subject as pending, owned by its author', async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');

      expect(subject.status).toBe('pending_approval');

      const res = await teacherA.agent
        .get(`${API_PREFIX}/teacher/subjects/${subject.id}`)
        .expect(200);
      expect((res.body as { created_by_teacher_id: string }).created_by_teacher_id).toBe(
        teacherA.userId,
      );
    });

    it('hides a pending subject from the public catalogue', async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');

      const list = await request(server).get(`${API_PREFIX}/subjects`).expect(200);
      expect(idsOf(list.body)).not.toContain(subject.id);

      await request(server).get(`${API_PREFIX}/subjects/${subject.id}`).expect(404);
    });

    it('offers a pending subject to its author but not to another teacher', async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');

      const mine = await teacherA.agent
        .get(`${API_PREFIX}/teacher/subjects/selectable`)
        .expect(200);
      expect(idsOf(mine.body)).toContain(subject.id);

      const theirs = await teacherB.agent
        .get(`${API_PREFIX}/teacher/subjects/selectable`)
        .expect(200);
      expect(idsOf(theirs.body)).not.toContain(subject.id);
    });

    it("404s every access to another teacher's pending subject", async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');

      await teacherB.agent.get(`${API_PREFIX}/teacher/subjects/${subject.id}`).expect(404);
      await teacherB.agent
        .put(`${API_PREFIX}/teacher/subjects/${subject.id}`)
        .send({ name: 'Hijacked' })
        .expect(404);
      await teacherB.agent.delete(`${API_PREFIX}/teacher/subjects/${subject.id}`).expect(404);
    });

    it('rejects a duplicate name regardless of case and surrounding whitespace', async () => {
      await createTeacherSubject(teacherA, 'Physics A');

      await teacherB.agent
        .post(`${API_PREFIX}/teacher/subjects`)
        .send({ name: '  PHYSICS a ' })
        .expect(409);
    });
  });

  describe('access control', () => {
    it('rejects anonymous and student access to the teacher surface', async () => {
      await request(server).get(`${API_PREFIX}/teacher/subjects`).expect(401);
      await student.agent.get(`${API_PREFIX}/teacher/subjects`).expect(403);
    });

    it('rejects a teacher calling the admin moderation routes', async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');

      await teacherA.agent
        .post(`${API_PREFIX}/admin/subjects/${subject.id}/approve`)
        .send({})
        .expect(403);
      await request(server)
        .post(`${API_PREFIX}/admin/subjects/${subject.id}/approve`)
        .send({})
        .expect(401);
    });
  });

  describe('content attachment', () => {
    it("lets the owner attach their pending subject but not another teacher", async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');

      await teacherB.agent
        .post(`${API_PREFIX}/teacher/lessons`)
        .send({ title: 'Borrowed lesson', subject_id: subject.id, price: 0, is_group: true })
        .expect(404);

      await teacherA.agent
        .post(`${API_PREFIX}/teacher/lessons`)
        .send({ title: 'My own lesson', subject_id: subject.id, price: 0, is_group: true })
        .expect(201);
    });
  });

  describe('admin list status counts (T053)', () => {
    it('meta.status_counts.pending_approval equals the pending queue total', async () => {
      await createTeacherSubject(teacherA, 'Physics A');
      await createTeacherSubject(teacherB, 'Chemistry B');

      const queue = await admin.agent.get(`${API_PREFIX}/admin/subjects/pending`).expect(200);
      const withCounts = await admin.agent
        .get(`${API_PREFIX}/admin/subjects?include_status_counts=true&limit=1`)
        .expect(200);
      const meta = (withCounts.body as { meta: { status_counts: Record<string, number> } }).meta;

      expect(meta.status_counts['pending_approval']).toBe(
        (queue.body as { meta: { total: number } }).meta.total,
      );
      // Global: independent of the list's own filter and page size.
      expect(meta.status_counts['pending_approval']).toBe(2);
    });

    it('absent flag leaves the body without status_counts; non-admins get 403', async () => {
      const plain = await admin.agent.get(`${API_PREFIX}/admin/subjects`).expect(200);
      expect((plain.body as { meta: object }).meta).not.toHaveProperty('status_counts');
      await teacherA.agent
        .get(`${API_PREFIX}/admin/subjects?include_status_counts=true`)
        .expect(403);
    });

    it('exam list returns zero-filled status_counts only when asked', async () => {
      const withCounts = await admin.agent
        .get(`${API_PREFIX}/admin/exams?include_status_counts=true&status=draft`)
        .expect(200);
      expect(
        (withCounts.body as { meta: { status_counts: object } }).meta.status_counts,
      ).toEqual({ draft: 0, published: 0, scheduled: 0, archived: 0 });
      const plain = await admin.agent.get(`${API_PREFIX}/admin/exams`).expect(200);
      expect((plain.body as { meta: object }).meta).not.toHaveProperty('status_counts');
    });
  });

  describe('approval lifecycle', () => {
    it('publishes the subject to everyone once approved', async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');

      const queue = await admin.agent.get(`${API_PREFIX}/admin/subjects/pending`).expect(200);
      expect(idsOf(queue.body)).toContain(subject.id);

      const approved = await admin.agent
        .post(`${API_PREFIX}/admin/subjects/${subject.id}/approve`)
        .send({})
        .expect(200);
      expect((approved.body as { subject: { status: string } }).subject.status).toBe('approved');

      const list = await request(server).get(`${API_PREFIX}/subjects`).expect(200);
      expect(idsOf(list.body)).toContain(subject.id);

      const theirs = await teacherB.agent
        .get(`${API_PREFIX}/teacher/subjects/selectable`)
        .expect(200);
      expect(idsOf(theirs.body)).toContain(subject.id);
    });

    it("403s — not 404s — once another teacher's subject is approved and therefore visible", async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');
      await admin.agent
        .post(`${API_PREFIX}/admin/subjects/${subject.id}/approve`)
        .send({})
        .expect(200);

      await teacherB.agent.get(`${API_PREFIX}/teacher/subjects/${subject.id}`).expect(403);
    });

    it('locks the owner out of editing once approved', async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');
      await admin.agent
        .post(`${API_PREFIX}/admin/subjects/${subject.id}/approve`)
        .send({})
        .expect(200);

      await teacherA.agent
        .put(`${API_PREFIX}/teacher/subjects/${subject.id}`)
        .send({ name: 'Physics Advanced' })
        .expect(409);
    });

    it('re-submits a rejected subject when its owner edits it', async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');
      const rejected = await admin.agent
        .post(`${API_PREFIX}/admin/subjects/${subject.id}/reject`)
        .send({ reason: 'Duplicate of an existing subject' })
        .expect(200);
      expect(
        (rejected.body as { subject: { rejection_reason: string } }).subject.rejection_reason,
      ).toBe('Duplicate of an existing subject');

      const resubmitted = await teacherA.agent
        .put(`${API_PREFIX}/teacher/subjects/${subject.id}`)
        .send({ name: 'Physics Foundations' })
        .expect(200);
      expect((resubmitted.body as { subject: { status: string } }).subject.status).toBe(
        'pending_approval',
      );
    });
  });

  describe('suspension', () => {
    it('removes the subject from every catalogue but leaves existing content editable', async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');
      await admin.agent
        .post(`${API_PREFIX}/admin/subjects/${subject.id}/approve`)
        .send({})
        .expect(200);

      const lesson = await teacherA.agent
        .post(`${API_PREFIX}/teacher/lessons`)
        .send({ title: 'Kinematics intro', subject_id: subject.id, price: 0, is_group: true })
        .expect(201);
      // `POST /teacher/lessons` answers `{ message, lesson }`, so the id lives
      // at `body.lesson.id`. Reading `body.id` yielded undefined, the next
      // request became `GET /teacher/lessons/undefined`, and ParseUUIDPipe
      // answered 400 — which is what this suite's long-standing "expected 200,
      // got 400" failure actually was. The suspension behaviour it guards was
      // never broken.
      const lessonId = (lesson.body as { lesson: { id: string } }).lesson.id;

      await admin.agent
        .post(`${API_PREFIX}/admin/subjects/${subject.id}/suspend`)
        .send({ reason: 'Under review' })
        .expect(200);

      const list = await request(server).get(`${API_PREFIX}/subjects`).expect(200);
      expect(idsOf(list.body)).not.toContain(subject.id);

      const selectable = await teacherA.agent
        .get(`${API_PREFIX}/teacher/subjects/selectable`)
        .expect(200);
      expect(idsOf(selectable.body)).not.toContain(subject.id);

      // The regression guard: re-saving a lesson whose subject_id has not
      // changed must not re-validate the (now suspended) subject.
      await teacherA.agent.get(`${API_PREFIX}/teacher/lessons/${lessonId}`).expect(200);
      await teacherA.agent
        .put(`${API_PREFIX}/teacher/lessons/${lessonId}`)
        .send({ title: 'Kinematics intro v2', subject_id: subject.id })
        .expect(200);
    });

    it('returns a reactivated subject to the catalogue', async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');
      await admin.agent
        .post(`${API_PREFIX}/admin/subjects/${subject.id}/approve`)
        .send({})
        .expect(200);
      await admin.agent
        .post(`${API_PREFIX}/admin/subjects/${subject.id}/suspend`)
        .send({ reason: 'Under review' })
        .expect(200);

      const reactivated = await admin.agent
        .post(`${API_PREFIX}/admin/subjects/${subject.id}/reactivate`)
        .expect(200);
      expect((reactivated.body as { subject: { status: string } }).subject.status).toBe(
        'approved',
      );
    });
  });

  describe('deletion', () => {
    it('refuses to delete a subject that content still references', async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');
      await teacherA.agent
        .post(`${API_PREFIX}/teacher/lessons`)
        .send({ title: 'Kinematics intro', subject_id: subject.id, price: 0, is_group: true })
        .expect(201);

      await admin.agent.delete(`${API_PREFIX}/admin/subjects/${subject.id}`).expect(409);
      await teacherA.agent.delete(`${API_PREFIX}/teacher/subjects/${subject.id}`).expect(409);
    });

    it('deletes an unreferenced subject', async () => {
      const subject = await createTeacherSubject(teacherA, 'Physics A');

      await admin.agent.delete(`${API_PREFIX}/admin/subjects/${subject.id}`).expect(200);
    });
  });

  describe('legacy rows and audit trail', () => {
    it('treats a row inserted without a status as approved and platform-owned', async () => {
      const [{ id }] = (await ctx.dataSource.query(
        `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), 'Legacy Subject') RETURNING id`,
      )) as [{ id: string }];

      const list = await request(server).get(`${API_PREFIX}/subjects`).expect(200);
      expect(idsOf(list.body)).toContain(id);

      const [row] = (await ctx.dataSource.query(
        `SELECT status, created_by_teacher_id FROM subjects WHERE id = $1`,
        [id],
      )) as [{ status: string; created_by_teacher_id: string | null }];
      expect(row.status).toBe('approved');
      expect(row.created_by_teacher_id).toBeNull();
    });

    it('records every moderation decision in audit_logs', async () => {
      const first = await createTeacherSubject(teacherA, 'Physics A');
      const second = await createTeacherSubject(teacherA, 'Chemistry A');

      await admin.agent
        .post(`${API_PREFIX}/admin/subjects/${first.id}/approve`)
        .send({})
        .expect(200);
      await admin.agent
        .post(`${API_PREFIX}/admin/subjects/${first.id}/suspend`)
        .send({ reason: 'Under review' })
        .expect(200);
      await admin.agent
        .post(`${API_PREFIX}/admin/subjects/${second.id}/reject`)
        .send({ reason: 'Duplicate' })
        .expect(200);

      const rows = (await ctx.dataSource.query(
        `SELECT action FROM audit_logs WHERE target_type = 'subject'`,
      )) as { action: string }[];
      const actions = rows.map((row) => row.action);

      expect(actions).toEqual(
        expect.arrayContaining([
          'subject_created',
          'subject_approved',
          'subject_suspended',
          'subject_rejected',
        ]),
      );
    });
  });
});
