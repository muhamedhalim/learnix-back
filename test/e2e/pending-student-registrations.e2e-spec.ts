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
  type RegisterPayload,
} from './fixtures';

interface StoredStudent {
  id: string;
  profile_id: string;
  name: string;
  email: string;
  status: string;
}

interface PendingStudentRow {
  id: string;
  user: { id: string; name: string; email: string; status: string };
}

describe('pending student registrations (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;
  let admin: AuthenticatedUser;

  const dropRaceDelay = async (): Promise<void> => {
    await ctx.dataSource.query('DROP TRIGGER IF EXISTS e2e_delay_guardian_insert ON guardians');
    await ctx.dataSource.query('DROP FUNCTION IF EXISTS e2e_delay_guardian_insert()');
  };

  const registerSequentially = async (payloads: RegisterPayload[]): Promise<void> => {
    for (const payload of payloads) {
      await request(server).post(`${API_PREFIX}/auth/register`).send(payload).expect(202);
    }
  };

  const storedStudents = async (payloads: RegisterPayload[]): Promise<StoredStudent[]> =>
    (await ctx.dataSource.query(
      `SELECT u.id, sp.id AS profile_id, u.name, u.email, u.status
         FROM users u
         JOIN student_profiles sp ON sp.user_id = u.id
        WHERE u.email = ANY($1)
        ORDER BY u.email`,
      [payloads.map((payload) => payload.email)],
    )) as StoredStudent[];

  const pendingStudents = async (): Promise<PendingStudentRow[]> => {
    const response = await admin.agent
      .get(`${API_PREFIX}/admin/students/pending`)
      .query({ page: 1, limit: 100 })
      .expect(200);

    expect(response.body.meta.total).toBe(response.body.data.length);
    return response.body.data as PendingStudentRow[];
  };

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await dropRaceDelay();
    await resetDatabase(ctx.dataSource);
    admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
  });

  afterEach(dropRaceDelay);
  afterAll(async () => ctx.app.close());

  it('returns one independently persisted pending student after one registration', async () => {
    const student = buildRegisterPayload({ name: 'Single Pending Student' });

    await registerSequentially([student]);

    await expect(storedStudents([student])).resolves.toMatchObject([
      { name: student.name, email: student.email, status: 'pending' },
    ]);
    await expect(pendingStudents()).resolves.toMatchObject([
      { user: { name: student.name, email: student.email, status: 'pending' } },
    ]);
  });

  it('preserves Student A and Student B after back-to-back registrations', async () => {
    const sharedParentPhone = '01011111111';
    const students = [
      buildRegisterPayload({ name: 'Student A', parentPhone: sharedParentPhone }),
      buildRegisterPayload({ name: 'Student B', parentPhone: sharedParentPhone }),
    ];

    await registerSequentially(students);

    const stored = await storedStudents(students);
    expect(stored).toHaveLength(2);
    expect(stored.every((student) => student.status === 'pending')).toBe(true);
    expect((await pendingStudents()).map((row) => row.user.email).sort()).toEqual(
      students.map((student) => student.email).sort(),
    );
  });

  it('preserves every registration in a larger back-to-back batch', async () => {
    const sharedParentPhone = '01022222222';
    const students = Array.from({ length: 6 }, (_, index) =>
      buildRegisterPayload({
        name: `Back-to-back Student ${index + 1}`,
        parentPhone: sharedParentPhone,
      }),
    );

    await registerSequentially(students);

    expect(await storedStudents(students)).toHaveLength(students.length);
    expect((await pendingStudents()).map((row) => row.user.email).sort()).toEqual(
      students.map((student) => student.email).sort(),
    );
  });

  it('preserves near-concurrent registrations that claim the same new guardian', async () => {
    // Widen the real PostgreSQL overlap deterministically. Before the fix, all
    // requests answered 202 but all except one transaction rolled back on the
    // guardian phone unique constraint.
    await ctx.dataSource.query(`
      CREATE FUNCTION e2e_delay_guardian_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.25);
        RETURN NEW;
      END $$
    `);
    await ctx.dataSource.query(`
      CREATE TRIGGER e2e_delay_guardian_insert
      BEFORE INSERT ON guardians
      FOR EACH ROW EXECUTE FUNCTION e2e_delay_guardian_insert()
    `);

    const sharedParentPhone = '01033333333';
    const students = Array.from({ length: 5 }, (_, index) =>
      buildRegisterPayload({
        name: `Concurrent Student ${index + 1}`,
        parentPhone: sharedParentPhone,
      }),
    );

    const responses = await Promise.all(
      students.map((student) => request(server).post(`${API_PREFIX}/auth/register`).send(student)),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);

    expect(await storedStudents(students)).toHaveLength(students.length);
    expect((await pendingStudents()).map((row) => row.user.email).sort()).toEqual(
      students.map((student) => student.email).sort(),
    );

    const guardianRows = (await ctx.dataSource.query(
      `SELECT COUNT(DISTINCT g.id)::int AS guardians,
              COUNT(DISTINCT sg.student_id)::int AS linked_students
         FROM guardians g
         JOIN student_guardians sg ON sg.guardian_id = g.id
        WHERE g.phone_e164 = $1`,
      ['+201033333333'],
    )) as { guardians: number; linked_students: number }[];
    expect(guardianRows[0]).toEqual({ guardians: 1, linked_students: students.length });
  });

  it('approves only the selected student while the other remains pending', async () => {
    const students = [
      buildRegisterPayload({ name: 'Student To Approve' }),
      buildRegisterPayload({ name: 'Student To Keep Pending' }),
    ];
    await registerSequentially(students);
    const stored = await storedStudents(students);
    const approved = stored.find((student) => student.email === students[0]?.email);
    if (!approved) throw new Error('Approved test student was not persisted');

    await admin.agent
      .post(`${API_PREFIX}/admin/students/${approved.profile_id}/approve`)
      .send({ notes: 'Regression approval' })
      .expect(201);

    const afterApproval = await storedStudents(students);
    expect(afterApproval.find((student) => student.email === students[0]?.email)?.status).toBe(
      'approved',
    );
    expect(afterApproval.find((student) => student.email === students[1]?.email)?.status).toBe(
      'pending',
    );
    await expect(pendingStudents()).resolves.toMatchObject([
      { user: { email: students[1]?.email, status: 'pending' } },
    ]);
  });

  it('returns all persisted pending students on a fresh Admin API request', async () => {
    const students = Array.from({ length: 3 }, (_, index) =>
      buildRegisterPayload({ name: `Refetch Student ${index + 1}` }),
    );
    await registerSequentially(students);

    const first = await pendingStudents();
    const second = await pendingStudents();
    const expectedEmails = students.map((student) => student.email).sort();

    expect(await storedStudents(students)).toHaveLength(students.length);
    expect(first.map((row) => row.user.email).sort()).toEqual(expectedEmails);
    expect(second.map((row) => row.user.email).sort()).toEqual(expectedEmails);
  });
});
