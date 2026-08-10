import { DataSource } from 'typeorm';

import { AddParentReports2083000000000 } from '../../src/migrations/2083000000000-AddParentReports';

/**
 * DEF-006 — proof that migration 2083 actually runs on PostgreSQL.
 *
 * The E2E application database is built by TypeORM `synchronize`, so the main
 * DEF-006 suite validates the *entities* and never executes a line of this
 * migration's SQL. A `DO $$ … $$` block, a partial index and a backfill are
 * exactly the kind of statements that type-check fine and fail at deploy time,
 * so they are executed here against a real, disposable database.
 *
 * A separate database rather than a schema: `CREATE TABLE IF NOT EXISTS` checks
 * visibility along `search_path`, so a schema-scoped run would silently skip
 * creating `parent_reports` because the application one already exists.
 */
jest.setTimeout(120_000);

const SCRATCH_DB = 'lms_def006_migration';

/** Minimal stand-ins carrying only the columns migration 2083 touches. */
const PREREQUISITE_SCHEMA = [
  `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,
  `CREATE TABLE "users" (
     "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4()
   )`,
  `CREATE TABLE "lesson_progress" (
     "id"         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
     "student_id" uuid NOT NULL,
     "lesson_id"  uuid NOT NULL,
     "completed"  boolean NOT NULL DEFAULT false,
     "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE "lesson_sessions" (
     "id"         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
     "student_id" uuid NOT NULL,
     "entered_at" TIMESTAMP NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE "attendance_records" (
     "id"         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
     "student_id" uuid NOT NULL,
     "marked_at"  TIMESTAMP NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE "exam_attempts" (
     "id"         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
     "student_id" uuid NOT NULL,
     "graded_at"  TIMESTAMP WITH TIME ZONE
   )`,
  `CREATE TABLE "homework_submissions" (
     "id"           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
     "student_id"   uuid NOT NULL,
     "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
   )`,
];

function adminUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') throw new Error('DATABASE_URL is not set');
  return url;
}

function scratchUrl(): string {
  const url = new URL(adminUrl());
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

describe('DEF-006 · migration 2083 against real PostgreSQL', () => {
  let admin: DataSource;
  let scratch: DataSource;

  const completedLong = '2026-02-01T10:30:00.000Z';

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: adminUrl() }).initialize();
    // CREATE DATABASE cannot run inside a transaction block, hence raw queries
    // on a plain connection rather than a migration runner.
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);

    scratch = await new DataSource({ type: 'postgres', url: scratchUrl() }).initialize();
    for (const statement of PREREQUISITE_SCHEMA) {
      await scratch.query(statement);
    }

    // Two completed rows and one unfinished, to exercise the backfill's WHERE.
    await scratch.query(`
      INSERT INTO "lesson_progress" ("student_id", "lesson_id", "completed", "updated_at")
      VALUES
        (uuid_generate_v4(), uuid_generate_v4(), true,  TIMESTAMPTZ '${completedLong}'),
        (uuid_generate_v4(), uuid_generate_v4(), true,  now()),
        (uuid_generate_v4(), uuid_generate_v4(), false, now())
    `);
  });

  afterAll(async () => {
    await scratch?.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
      await admin.destroy();
    }
  });

  async function runUp(): Promise<void> {
    const runner = scratch.createQueryRunner();
    try {
      await new AddParentReports2083000000000().up(runner);
    } finally {
      await runner.release();
    }
  }

  async function runDown(): Promise<void> {
    const runner = scratch.createQueryRunner();
    try {
      await new AddParentReports2083000000000().down(runner);
    } finally {
      await runner.release();
    }
  }

  async function exists(sql: string, params: unknown[] = []): Promise<boolean> {
    const rows = (await scratch.query(sql, params)) as unknown[];
    return rows.length > 0;
  }

  it('executes cleanly and creates the parent_reports table', async () => {
    await runUp();

    expect(
      await exists(`SELECT 1 FROM information_schema.tables WHERE table_name = 'parent_reports'`),
    ).toBe(true);

    const columns = (await scratch.query(`
      SELECT column_name, data_type
        FROM information_schema.columns
       WHERE table_name = 'parent_reports'
    `)) as { column_name: string; data_type: string }[];

    const byName = new Map(columns.map((c) => [c.column_name, c.data_type]));
    expect(byName.get('period_start')).toBe('timestamp with time zone');
    expect(byName.get('period_end')).toBe('timestamp with time zone');
    expect(byName.get('payload')).toBe('jsonb');
    expect(byName.get('time_zone')).toBe('character varying');
  });

  it('creates both enum types', async () => {
    for (const typeName of ['parent_reports_report_type_enum', 'parent_reports_status_enum']) {
      expect(await exists(`SELECT 1 FROM pg_type WHERE typname = $1`, [typeName])).toBe(true);
    }
  });

  it('enforces one report per (student, type, period) at the database level', async () => {
    const studentId = (
      (await scratch.query(`INSERT INTO "users" DEFAULT VALUES RETURNING id`)) as { id: string }[]
    )[0]?.id;

    const insert = `
      INSERT INTO "parent_reports"
        ("student_id", "report_type", "period_key", "period_start", "period_end", "time_zone")
      VALUES ($1, 'weekly', 'w2026-08-03',
              TIMESTAMPTZ '2026-08-02T21:00:00Z', TIMESTAMPTZ '2026-08-09T21:00:00Z',
              'Africa/Cairo')
    `;

    await scratch.query(insert, [studentId]);
    // The second insert is the guarantee the whole feature rests on.
    await expect(scratch.query(insert, [studentId])).rejects.toThrow(
      /duplicate key value violates unique constraint/i,
    );

    // A different period for the same student is unaffected.
    await scratch.query(
      `INSERT INTO "parent_reports"
         ("student_id", "report_type", "period_key", "period_start", "period_end", "time_zone")
       VALUES ($1, 'monthly', 'm2026-07',
               TIMESTAMPTZ '2026-06-30T21:00:00Z', TIMESTAMPTZ '2026-07-31T21:00:00Z',
               'Africa/Cairo')`,
      [studentId],
    );

    await scratch.query(`DELETE FROM "parent_reports"`);
  });

  it('backfills completed_at only for already-completed rows', async () => {
    const rows = (await scratch.query(`
      SELECT "completed", "completed_at", "updated_at"
        FROM "lesson_progress"
       ORDER BY "completed" DESC, "updated_at" ASC
    `)) as { completed: boolean; completed_at: Date | null; updated_at: Date }[];

    const [oldest, recent, unfinished] = rows;

    // Seeded from updated_at — documented as exact for rows never re-watched.
    expect(oldest?.completed_at?.toISOString()).toBe(completedLong);
    expect(recent?.completed_at).not.toBeNull();
    // An unfinished lesson has no completion instant to record.
    expect(unfinished?.completed).toBe(false);
    expect(unfinished?.completed_at).toBeNull();
  });

  it('creates the indexes the aggregator depends on', async () => {
    const rows = (await scratch.query(`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `)) as { indexname: string }[];
    const names = new Set(rows.map((row) => row.indexname));

    for (const expected of [
      'UQ_parent_reports_student_type_period',
      'IDX_parent_reports_student',
      'IDX_parent_reports_status',
      'IDX_parent_reports_type_period',
      'IDX_lesson_progress_completed_at',
      'IDX_lesson_sessions_student_entered',
      'IDX_attendance_student_marked_at',
      'IDX_exam_attempts_student_graded_at',
      'IDX_homework_submissions_student_submitted',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('is safe to run twice (interrupted deploy, re-run)', async () => {
    await expect(runUp()).resolves.toBeUndefined();

    // The backfill must not have moved the already-stamped timestamp.
    const rows = (await scratch.query(`
      SELECT "completed_at" FROM "lesson_progress"
       WHERE "completed" = true ORDER BY "updated_at" ASC LIMIT 1
    `)) as { completed_at: Date }[];
    expect(rows[0]?.completed_at.toISOString()).toBe(completedLong);
  });

  it('rolls back cleanly, leaving the prerequisite tables intact', async () => {
    await runDown();

    expect(
      await exists(`SELECT 1 FROM information_schema.tables WHERE table_name = 'parent_reports'`),
    ).toBe(false);
    expect(await exists(`SELECT 1 FROM pg_type WHERE typname = 'parent_reports_status_enum'`)).toBe(
      false,
    );
    expect(
      await exists(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'lesson_progress' AND column_name = 'completed_at'`,
      ),
    ).toBe(false);

    // Rollback must not take the borrowed tables with it.
    expect(
      await exists(`SELECT 1 FROM information_schema.tables WHERE table_name = 'lesson_progress'`),
    ).toBe(true);
  });
});
