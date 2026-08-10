import { DataSource, type QueryRunner } from 'typeorm';

import { ParentEventType } from '../../src/common/events/parent-event-type.enum';
import { ConsolidateGuardianNotificationPreferences2079000000000 } from '../../src/migrations/2079000000000-ConsolidateGuardianNotificationPreferences';

/**
 * DEF-005 — the reconciliation migration, executed against real PostgreSQL.
 *
 * A shape-of-the-SQL unit test cannot answer the question that actually
 * matters here, which is "does a student who opted out of attendance messages
 * stay opted out after their preference model is replaced". So this runs the
 * migration for real and reads the rows back.
 *
 * The E2E schema is built by TypeORM `synchronize`, so the four legacy columns
 * no longer exist. The `beforeEach` recreates them, which is exactly the
 * pre-migration state a production database is in.
 */
describe('DEF-005 · guardian preference consolidation migration (PostgreSQL)', () => {
  let dataSource: DataSource;
  let runner: QueryRunner;

  const migration = new ConsolidateGuardianNotificationPreferences2079000000000();

  beforeAll(async () => {
    const url = process.env['DATABASE_URL'];
    if (url === undefined || url === '') throw new Error('DATABASE_URL is required for E2E');

    dataSource = new DataSource({ type: 'postgres', url, synchronize: false });
    await dataSource.initialize();
    runner = dataSource.createQueryRunner();
  });

  afterAll(async () => {
    await runner.release();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await runner.query('DROP TABLE IF EXISTS "notification_settings_legacy_parent_toggles"');
    await runner.query('DELETE FROM "student_guardians"');
    await runner.query('DELETE FROM "notification_settings"');
    await runner.query('DELETE FROM "guardians"');
    await runner.query(`DELETE FROM "users" WHERE email LIKE 'def005-%'`);

    // Re-create the pre-migration shape.
    await runner.query(`
      ALTER TABLE "notification_settings"
        ADD COLUMN IF NOT EXISTS "notify_parent_on_attendance" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "notify_parent_on_exam_grade" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "notify_parent_on_lesson_expiry" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "notify_on_purchase" boolean NOT NULL DEFAULT true
    `);
  });

  afterEach(async () => {
    // Leave the schema as `synchronize` expects it for any suite that follows.
    await runner.query(`
      ALTER TABLE "notification_settings"
        DROP COLUMN IF EXISTS "notify_parent_on_attendance",
        DROP COLUMN IF EXISTS "notify_parent_on_exam_grade",
        DROP COLUMN IF EXISTS "notify_parent_on_lesson_expiry",
        DROP COLUMN IF EXISTS "notify_on_purchase"
    `);
    await runner.query('DROP TABLE IF EXISTS "notification_settings_legacy_parent_toggles"');
  });

  async function createStudent(slug: string): Promise<string> {
    const rows = (await runner.query(
      `INSERT INTO "users" ("username", "name", "email", "password_hash", "phone", "role", "status")
       VALUES ($1, $1, $2, 'x', $3, 'student', 'approved') RETURNING id`,
      [`def005-${slug}`, `def005-${slug}@example.com`, `+2010000${slug.padStart(5, '0')}`],
    )) as Array<{ id: string }>;
    return rows[0]!.id;
  }

  async function createGuardianLink(
    studentId: string,
    phone: string,
    preferences: Record<string, boolean>,
  ): Promise<string> {
    const guardian = (await runner.query(
      `INSERT INTO "guardians" ("phone_e164", "full_name", "preferred_language", "verification_status", "whatsapp_capable")
       VALUES ($1, 'Parent', 'ar', 'verified', true) RETURNING id`,
      [phone],
    )) as Array<{ id: string }>;
    const guardianId = guardian[0]!.id;

    await runner.query(
      `INSERT INTO "student_guardians"
         ("student_id", "guardian_id", "relationship", "is_primary", "receives_notifications", "notification_preferences")
       VALUES ($1, $2, 'other', true, true, $3::jsonb)`,
      [studentId, guardianId, JSON.stringify(preferences)],
    );
    return guardianId;
  }

  async function legacySettings(
    userId: string,
    values: {
      attendance: boolean;
      examGrade: boolean;
      lessonExpiry: boolean;
      purchase: boolean;
    },
  ): Promise<void> {
    await runner.query(
      `INSERT INTO "notification_settings"
         ("user_id", "sms_enabled", "email_enabled", "push_enabled",
          "notify_parent_on_attendance", "notify_parent_on_exam_grade",
          "notify_parent_on_lesson_expiry", "notify_on_purchase")
       VALUES ($1, true, false, false, $2, $3, $4, $5)`,
      [userId, values.attendance, values.examGrade, values.lessonExpiry, values.purchase],
    );
  }

  async function preferencesOf(studentId: string): Promise<Record<string, boolean>> {
    const rows = (await runner.query(
      `SELECT "notification_preferences" AS p FROM "student_guardians" WHERE "student_id" = $1`,
      [studentId],
    )) as Array<{ p: Record<string, boolean> }>;
    return rows[0]!.p;
  }

  it('migrates an explicit legacy opt-out into the canonical guardian model', async () => {
    const studentId = await createStudent('optout');
    await createGuardianLink(studentId, '+201110000001', {});
    await legacySettings(studentId, {
      attendance: false,
      examGrade: false,
      lessonExpiry: false,
      purchase: false,
    });

    await migration.up(runner);

    expect(await preferencesOf(studentId)).toEqual({
      [ParentEventType.ATTENDANCE_MARKED]: false,
      [ParentEventType.EXAM_GRADED]: false,
      [ParentEventType.COURSE_PURCHASED]: false,
    });
  });

  it('does not write anything for a legacy `true` — it carries no decision', async () => {
    const studentId = await createStudent('alltrue');
    await createGuardianLink(studentId, '+201110000002', {});
    await legacySettings(studentId, {
      attendance: true,
      examGrade: true,
      lessonExpiry: true,
      purchase: true,
    });

    await migration.up(runner);

    // Every mapped event already defaults to true, so a legacy `true` is
    // indistinguishable from "never touched" and must not create noise.
    expect(await preferencesOf(studentId)).toEqual({});
  });

  it('canonical wins: an explicit guardian preference is never overwritten', async () => {
    const studentId = await createStudent('conflict');
    await createGuardianLink(studentId, '+201110000003', {
      // The student explicitly re-enabled attendance through /student/guardians.
      [ParentEventType.ATTENDANCE_MARKED]: true,
    });
    await legacySettings(studentId, {
      attendance: false, // legacy says off …
      examGrade: false,
      lessonExpiry: true,
      purchase: true,
    });

    await migration.up(runner);

    const preferences = await preferencesOf(studentId);
    // … the canonical `true` survives.
    expect(preferences[ParentEventType.ATTENDANCE_MARKED]).toBe(true);
    // … while an event the canonical model was silent about is filled in.
    expect(preferences[ParentEventType.EXAM_GRADED]).toBe(false);
  });

  it('applies the opt-out to every guardian link of that student', async () => {
    const studentId = await createStudent('twolinks');
    await createGuardianLink(studentId, '+201110000004', {});
    await createGuardianLink(studentId, '+201110000005', {});
    await legacySettings(studentId, {
      attendance: false,
      examGrade: true,
      lessonExpiry: true,
      purchase: true,
    });

    await migration.up(runner);

    const rows = (await runner.query(
      `SELECT "notification_preferences" AS p FROM "student_guardians" WHERE "student_id" = $1`,
      [studentId],
    )) as Array<{ p: Record<string, boolean> }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.p[ParentEventType.ATTENDANCE_MARKED]).toBe(false);
    }
  });

  it('never touches another student’s guardian links', async () => {
    const optedOut = await createStudent('scoped-a');
    const untouched = await createStudent('scoped-b');
    await createGuardianLink(optedOut, '+201110000006', {});
    await createGuardianLink(untouched, '+201110000007', {});
    await legacySettings(optedOut, {
      attendance: false,
      examGrade: false,
      lessonExpiry: false,
      purchase: false,
    });
    await legacySettings(untouched, {
      attendance: true,
      examGrade: true,
      lessonExpiry: true,
      purchase: true,
    });

    await migration.up(runner);

    expect(await preferencesOf(untouched)).toEqual({});
  });

  it('archives all four columns verbatim and then drops them', async () => {
    const studentId = await createStudent('archive');
    await legacySettings(studentId, {
      attendance: false,
      examGrade: true,
      lessonExpiry: false,
      purchase: true,
    });

    await migration.up(runner);

    const archived = (await runner.query(
      `SELECT * FROM "notification_settings_legacy_parent_toggles" WHERE "user_id" = $1`,
      [studentId],
    )) as Array<Record<string, boolean>>;
    expect(archived[0]).toMatchObject({
      notify_parent_on_attendance: false,
      notify_parent_on_exam_grade: true,
      // No canonical counterpart exists for lesson expiry — archived, not lost.
      notify_parent_on_lesson_expiry: false,
      notify_on_purchase: true,
    });

    const columns = (await runner.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'notification_settings' AND column_name LIKE 'notify_%'`,
    )) as Array<{ column_name: string }>;
    expect(columns).toHaveLength(0);
  });

  it('preserves the three channel preferences and the settings rows themselves', async () => {
    const studentId = await createStudent('channels');
    await runner.query(
      `INSERT INTO "notification_settings"
         ("user_id", "sms_enabled", "email_enabled", "push_enabled",
          "notify_parent_on_attendance", "notify_parent_on_exam_grade",
          "notify_parent_on_lesson_expiry", "notify_on_purchase")
       VALUES ($1, false, true, true, false, false, false, false)`,
      [studentId],
    );

    await migration.up(runner);

    const rows = (await runner.query(
      `SELECT "sms_enabled", "email_enabled", "push_enabled" FROM "notification_settings" WHERE "user_id" = $1`,
      [studentId],
    )) as Array<{ sms_enabled: boolean; email_enabled: boolean; push_enabled: boolean }>;
    expect(rows[0]).toEqual({ sms_enabled: false, email_enabled: true, push_enabled: true });
  });

  it('is a no-op on a database that has already been migrated', async () => {
    const studentId = await createStudent('idempotent');
    await createGuardianLink(studentId, '+201110000008', {});
    await legacySettings(studentId, {
      attendance: false,
      examGrade: true,
      lessonExpiry: true,
      purchase: true,
    });

    await migration.up(runner);
    const afterFirst = await preferencesOf(studentId);

    await expect(migration.up(runner)).resolves.toBeUndefined();
    expect(await preferencesOf(studentId)).toEqual(afterFirst);
  });

  it('restores the legacy columns verbatim on rollback', async () => {
    const studentId = await createStudent('rollback');
    await legacySettings(studentId, {
      attendance: false,
      examGrade: true,
      lessonExpiry: false,
      purchase: true,
    });

    await migration.up(runner);
    await migration.down(runner);

    const rows = (await runner.query(
      `SELECT "notify_parent_on_attendance" AS a, "notify_parent_on_exam_grade" AS e,
              "notify_parent_on_lesson_expiry" AS l, "notify_on_purchase" AS p
         FROM "notification_settings" WHERE "user_id" = $1`,
      [studentId],
    )) as Array<{ a: boolean; e: boolean; l: boolean; p: boolean }>;
    expect(rows[0]).toEqual({ a: false, e: true, l: false, p: true });
  });
});
