import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

/** Mirrors `toE164` for Egyptian mobiles: '01XXXXXXXXX' -> '+20XXXXXXXXX'. */
function toE164(phone: string): string {
  return `+20${phone.slice(1)}`;
}

interface UserRow {
  name: string;
  phone: string;
}

interface GuardianLinkRow {
  is_primary: boolean;
  phone_e164: string;
}

async function loadUser(ctx: E2EContext, userId: string): Promise<UserRow> {
  const rows = (await ctx.dataSource.query(
    'SELECT name, phone FROM users WHERE id = $1',
    [userId],
  )) as UserRow[];
  const row = rows[0];
  if (row === undefined) throw new Error(`User ${userId} not found`);
  return row;
}

async function loadGuardianLinks(ctx: E2EContext, studentId: string): Promise<GuardianLinkRow[]> {
  return (await ctx.dataSource.query(
    `SELECT sg.is_primary, g.phone_e164
     FROM student_guardians sg
     JOIN guardians g ON g.id = sg.guardian_id
     WHERE sg.student_id = $1
     ORDER BY g.phone_e164`,
    [studentId],
  )) as GuardianLinkRow[];
}

/**
 * DEF-003 — the legacy `PUT /callcenter/students/:studentId` route allowed
 * `call_center` to write the full student administrative profile (including
 * linking/replacing a Primary Guardian) despite the sibling GET routes on the
 * same controller already being Admin-only. Resolved policy: the legacy
 * update route is Admin-only; Call Center keeps only the sanitized support
 * projection (`GET /callcenter/users*`).
 */
describe('Call Center legacy student update authorization boundary (DEF-003) (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  it('allows Admin to update the student profile and replace the Primary Guardian through the legacy route', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);

    const originalGuardians = await loadGuardianLinks(ctx, student.userId);
    expect(originalGuardians).toHaveLength(1);
    expect(originalGuardians[0]).toMatchObject({ is_primary: true });

    const newPhone = '01099911122';
    const newGuardianPhone = '01055566677';

    await admin.agent
      .put(`${API_PREFIX}/callcenter/students/${student.userId}`)
      .send({ name: 'Updated By Admin', phone: newPhone, parent_phone: newGuardianPhone })
      .expect(200);

    const user = await loadUser(ctx, student.userId);
    expect(user).toMatchObject({ name: 'Updated By Admin', phone: newPhone });

    const guardians = await loadGuardianLinks(ctx, student.userId);
    expect(guardians).toHaveLength(2);
    const primary = guardians.find((g) => g.is_primary);
    expect(primary?.phone_e164).toBe(toE164(newGuardianPhone));
    const demoted = guardians.find((g) => !g.is_primary);
    expect(demoted?.phone_e164).toBe(originalGuardians[0]!.phone_e164);
  });

  it('returns 403 for Call Center with a valid student UUID and performs zero student or Guardian mutation', async () => {
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);

    const originalUser = await loadUser(ctx, student.userId);
    const originalGuardians = await loadGuardianLinks(ctx, student.userId);
    const attemptedGuardianPhone = '01044433322';

    await support.agent
      .put(`${API_PREFIX}/callcenter/students/${student.userId}`)
      .send({ name: 'Blocked', phone: '01099911122', parent_phone: attemptedGuardianPhone })
      .expect(403);

    expect(await loadUser(ctx, student.userId)).toEqual(originalUser);
    expect(await loadGuardianLinks(ctx, student.userId)).toEqual(originalGuardians);
    const attemptedGuardianRows = (await ctx.dataSource.query(
      'SELECT id FROM guardians WHERE phone_e164 = $1',
      [toE164(attemptedGuardianPhone)],
    )) as Array<{ id: string }>;
    expect(attemptedGuardianRows).toHaveLength(0);
  });

  it('rejects Call Center DTO variations — guardian-only payload and empty body — with 403 and no mutation', async () => {
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);

    const originalUser = await loadUser(ctx, student.userId);
    const originalGuardians = await loadGuardianLinks(ctx, student.userId);

    // Guardian-only payload: omits name/phone entirely, attempting to reach
    // GuardiansService.linkGuardian without touching UsersService.update.
    await support.agent
      .put(`${API_PREFIX}/callcenter/students/${student.userId}`)
      .send({ parent_phone: '01066677788' })
      .expect(403);

    // Empty body — no DTO fields at all.
    await support.agent
      .put(`${API_PREFIX}/callcenter/students/${student.userId}`)
      .send({})
      .expect(403);

    expect(await loadUser(ctx, student.userId)).toEqual(originalUser);
    expect(await loadGuardianLinks(ctx, student.userId)).toEqual(originalGuardians);
  });

  it('rejects unauthenticated and non-admin roles on the legacy update route', async () => {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const otherStudent = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });

    await request(server)
      .put(`${API_PREFIX}/callcenter/students/${student.userId}`)
      .send({ name: 'Anon' })
      .expect(401);
    await otherStudent.agent
      .put(`${API_PREFIX}/callcenter/students/${student.userId}`)
      .send({ name: 'Peer' })
      .expect(403);
    await teacher.agent
      .put(`${API_PREFIX}/callcenter/students/${student.userId}`)
      .send({ name: 'Teacher' })
      .expect(403);

    expect(await loadUser(ctx, student.userId)).toMatchObject({ name: student.credentials.name });
  });

  it('keeps the Admin GET surface and the Call Center support projection unchanged around the boundary', async () => {
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);

    await admin.agent.get(`${API_PREFIX}/callcenter/students/${student.userId}`).expect(200);
    await admin.agent.get(`${API_PREFIX}/callcenter/students`).expect(200);
    await support.agent.get(`${API_PREFIX}/callcenter/students/${student.userId}`).expect(403);
    await support.agent.get(`${API_PREFIX}/callcenter/students`).expect(403);

    // The permission-scoped support projection stays available to Call Center.
    await support.agent
      .get(`${API_PREFIX}/callcenter/users`)
      .query({ search: student.credentials.email, page: 1, limit: 20 })
      .expect(200);
  });
});
