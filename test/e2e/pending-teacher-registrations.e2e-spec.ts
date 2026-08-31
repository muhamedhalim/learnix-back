import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  buildRegisterPayload,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';

interface StoredTeacher {
  id: string;
  profile_id: string;
  name: string;
  email: string;
  status: string;
}

interface PendingTeacherRow {
  id: string;
  user: { id: string; name: string; email: string; status: string };
}

describe('pending teacher registrations (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;
  let admin: AuthenticatedUser;

  const registerTeacher = (overrides: Partial<Parameters<typeof buildRegisterPayload>[0]> = {}) =>
    buildRegisterPayload({ requestedRole: 'teacher', ...overrides });

  const storedTeacher = async (email: string): Promise<StoredTeacher | undefined> => {
    const rows = (await ctx.dataSource.query(
      `SELECT u.id, tp.id AS profile_id, u.name, u.email, u.status
         FROM users u
         JOIN teacher_profiles tp ON tp.user_id = u.id
        WHERE u.email = $1`,
      [email],
    )) as StoredTeacher[];
    return rows[0];
  };

  const pendingTeachers = async (): Promise<PendingTeacherRow[]> => {
    const response = await admin.agent
      .get(`${API_PREFIX}/admin/teachers/pending`)
      .query({ page: 1, limit: 100 })
      .expect(200);

    expect(response.body.meta.total).toBe(response.body.data.length);
    return response.body.data as PendingTeacherRow[];
  };

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
  });

  afterAll(async () => ctx.app.close());

  it('creates a PENDING user + teacher_profiles row on registration', async () => {
    const teacher = registerTeacher({ name: 'Newly Registered Teacher' });

    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);

    await expect(storedTeacher(teacher.email)).resolves.toMatchObject({
      name: teacher.name,
      email: teacher.email,
      status: 'pending',
    });
  });

  it('surfaces the pending teacher in the admin approval queue', async () => {
    const teacher = registerTeacher({ name: 'Queue Visible Teacher' });
    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);

    await expect(pendingTeachers()).resolves.toMatchObject([
      { user: { name: teacher.name, email: teacher.email, status: 'pending' } },
    ]);
  });

  it('is findable by name search even though first_name/last_name are never set at self-registration', async () => {
    const teacher = registerTeacher({ name: 'Searchable Registrant Example' });
    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);

    const response = await admin.agent
      .get(`${API_PREFIX}/admin/teachers`)
      .query({ search: 'Searchable Registrant' })
      .expect(200);

    expect(
      (response.body.data as { user: { email: string } }[]).map((row) => row.user.email),
    ).toContain(teacher.email);
  });

  it('rejects a non-admin caller from every approval endpoint', async () => {
    const teacher = registerTeacher();
    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);
    const teacherId = await storedTeacher(teacher.email).then((row) => row?.profile_id);

    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'student' });

    await student.agent.get(`${API_PREFIX}/admin/teachers/pending`).expect(403);
    await student.agent.get(`${API_PREFIX}/admin/teachers`).expect(403);
    await student.agent
      .post(`${API_PREFIX}/admin/teachers/${teacherId}/approve`)
      .send({})
      .expect(403);
    await student.agent
      .post(`${API_PREFIX}/admin/teachers/${teacherId}/reject`)
      .send({ reason: 'no' })
      .expect(403);
  });

  it('lets the admin view a single pending teacher by id', async () => {
    const teacher = registerTeacher({ name: 'Detail View Teacher' });
    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);
    const stored = await storedTeacher(teacher.email);
    if (!stored) throw new Error('teacher was not persisted');

    const response = await admin.agent
      .get(`${API_PREFIX}/admin/teachers/${stored.profile_id}`)
      .expect(200);

    expect(response.body).toMatchObject({ user: { email: teacher.email, status: 'pending' } });
  });

  it('approves a pending teacher and flips their status to approved', async () => {
    const teacher = registerTeacher({ name: 'Approve Me Teacher' });
    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);
    const stored = await storedTeacher(teacher.email);
    if (!stored) throw new Error('teacher was not persisted');

    await admin.agent
      .post(`${API_PREFIX}/admin/teachers/${stored.profile_id}/approve`)
      .send({ notes: 'Looks good' })
      .expect(200);

    await expect(storedTeacher(teacher.email)).resolves.toMatchObject({ status: 'approved' });

    // Approved teacher can now log in.
    const loginRes = await request(server)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: teacher.email, password: teacher.password })
      .expect(200);
    expect(loginRes.body.status).not.toBe('pending');
  });

  it('rejects a pending teacher, records the reason, and blocks their login', async () => {
    const teacher = registerTeacher({ name: 'Reject Me Teacher' });
    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);
    const stored = await storedTeacher(teacher.email);
    if (!stored) throw new Error('teacher was not persisted');

    await admin.agent
      .post(`${API_PREFIX}/admin/teachers/${stored.profile_id}/reject`)
      .send({ reason: 'Missing certification documents' })
      .expect(200);

    await expect(storedTeacher(teacher.email)).resolves.toMatchObject({ status: 'rejected' });

    const loginRes = await request(server)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: teacher.email, password: teacher.password })
      .expect(401);
    expect(loginRes.body.detail).toMatch(/rejected/i);
  });

  it('requires a non-empty reason to reject', async () => {
    const teacher = registerTeacher();
    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);
    const stored = await storedTeacher(teacher.email);
    if (!stored) throw new Error('teacher was not persisted');

    await admin.agent
      .post(`${API_PREFIX}/admin/teachers/${stored.profile_id}/reject`)
      .send({ reason: '' })
      .expect(400);
  });

  it('does not list an already-approved teacher as pending', async () => {
    const teacher = registerTeacher({ name: 'Already Approved Teacher' });
    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);
    const stored = await storedTeacher(teacher.email);
    if (!stored) throw new Error('teacher was not persisted');

    await admin.agent
      .post(`${API_PREFIX}/admin/teachers/${stored.profile_id}/approve`)
      .send({})
      .expect(200);

    const pending = await pendingTeachers();
    expect(pending.map((row) => row.user.email)).not.toContain(teacher.email);
  });

  it('rejects a duplicate approve on an already-approved teacher with 409, leaving status unchanged', async () => {
    const teacher = registerTeacher();
    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);
    const stored = await storedTeacher(teacher.email);
    if (!stored) throw new Error('teacher was not persisted');

    await admin.agent
      .post(`${API_PREFIX}/admin/teachers/${stored.profile_id}/approve`)
      .send({})
      .expect(200);
    await admin.agent
      .post(`${API_PREFIX}/admin/teachers/${stored.profile_id}/approve`)
      .send({})
      .expect(409);

    await expect(storedTeacher(teacher.email)).resolves.toMatchObject({ status: 'approved' });
  });

  it('lets only one of two concurrent double-click approvals win, the other gets 409', async () => {
    // Approve and reject are both legitimate, reversible admin actions (the
    // UI lets an admin flip a teacher from approved back to rejected or vice
    // versa), so a *race between different actions* has no single correct
    // winner — whichever commits last legitimately determines the final
    // status. What must never happen is the SAME action (a literal
    // double-click) succeeding twice with no error, which is exactly what
    // the pessimistic lock in approveTeacher/rejectTeacher exists to prevent.
    const teacher = registerTeacher({ name: 'Double Click Teacher' });
    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);
    const stored = await storedTeacher(teacher.email);
    if (!stored) throw new Error('teacher was not persisted');

    const [first, second] = await Promise.all([
      admin.agent.post(`${API_PREFIX}/admin/teachers/${stored.profile_id}/approve`).send({}),
      admin.agent.post(`${API_PREFIX}/admin/teachers/${stored.profile_id}/approve`).send({}),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    await expect(storedTeacher(teacher.email)).resolves.toMatchObject({ status: 'approved' });
  });

  it('lets only one of two concurrent double-click rejections win, the other gets 409', async () => {
    const teacher = registerTeacher({ name: 'Double Click Reject Teacher' });
    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);
    const stored = await storedTeacher(teacher.email);
    if (!stored) throw new Error('teacher was not persisted');

    const [first, second] = await Promise.all([
      admin.agent
        .post(`${API_PREFIX}/admin/teachers/${stored.profile_id}/reject`)
        .send({ reason: 'Double click reject A' }),
      admin.agent
        .post(`${API_PREFIX}/admin/teachers/${stored.profile_id}/reject`)
        .send({ reason: 'Double click reject B' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    await expect(storedTeacher(teacher.email)).resolves.toMatchObject({ status: 'rejected' });
  });

  it('lets a race between approve and reject resolve to whichever commits last, with no corrupted intermediate state', async () => {
    const teacher = registerTeacher({ name: 'Race Condition Teacher' });
    await request(server).post(`${API_PREFIX}/auth/register`).send(teacher).expect(202);
    const stored = await storedTeacher(teacher.email);
    if (!stored) throw new Error('teacher was not persisted');

    const [approveRes, rejectRes] = await Promise.all([
      admin.agent.post(`${API_PREFIX}/admin/teachers/${stored.profile_id}/approve`).send({}),
      admin.agent
        .post(`${API_PREFIX}/admin/teachers/${stored.profile_id}/reject`)
        .send({ reason: 'Racing rejection' }),
    ]);

    // Both are individually valid actions from PENDING, so both may return
    // 200 — the pessimistic lock only guarantees they apply one at a time
    // (never interleaved), not that the second one is rejected. The
    // non-negotiable invariant is that the row ends up in exactly the status
    // the *last committed* write set — never PENDING, and never a value
    // neither caller asked for.
    expect(approveRes.status).toBe(200);
    expect(rejectRes.status).toBe(200);

    const final = await storedTeacher(teacher.email);
    expect(['approved', 'rejected']).toContain(final?.status);
  });
});
