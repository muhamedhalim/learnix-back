import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DEF-006 — weekly / monthly guardian reports.
 *
 * Schema (additive only):
 *
 *  - `parent_reports` stores one aggregated report per (student, type, period).
 *    The UNIQUE constraint on those four columns is the report engine's
 *    idempotency guarantee, enforced by Postgres rather than by application
 *    logic: two schedulers firing at once, a worker restarted mid-sweep and a
 *    manual replay all race on this index and exactly one wins. The delivery
 *    half of the key (which guardian) already lives in
 *    `parent_messages.idempotency_key`; together they give the required
 *    (relationship, student, type, period start, period end) identity.
 *
 *  - `lesson_progress.completed_at` records WHEN a lesson was finished.
 *    Without it there is no honest way to answer "what did this student
 *    complete last week?" — `ProgressService.updateProgress` rewrites the row
 *    on every progress ping, so `updated_at` drifts forward whenever a student
 *    re-watches something they finished months ago.
 *
 * Data (backfill): `completed_at` is seeded from `updated_at` for rows already
 * marked completed. For the overwhelming majority this is not a guess — the
 * completion write WAS the last write to the row, so `updated_at` is the
 * completion instant exactly. It is late only for lessons that were re-watched
 * after completion, and no record of the true instant survives for those.
 *
 * DOCUMENTED LIMITATION: consequently, a lesson completed long ago but
 * re-watched recently may be counted in the first report period after this
 * migration. The alternative — leaving the column NULL — would report zero
 * completions for every student in that first period, which is wrong for
 * everybody rather than slightly late for a few. Only pre-migration rows are
 * affected; every completion from here on is stamped at the transition itself.
 */
export class AddParentReports2083000000000 implements MigrationInterface {
  public name = 'AddParentReports2083000000000';

  public async up(q: QueryRunner): Promise<void> {
    /* ------------------------- lesson_progress.completed_at ------------------ */

    await q.query(
      `ALTER TABLE "lesson_progress" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMP WITH TIME ZONE`,
    );

    // For UPDATE/DELETE, TypeORM's Postgres query runner returns `[rows, rowCount]`, not the rows,
    // so `.length` of the result was always 2 regardless of how many rows changed (FIA-003).
    const [, backfilledCount] = (await q.query(`
      UPDATE "lesson_progress"
         SET "completed_at" = "updated_at"
       WHERE "completed" = true
         AND "completed_at" IS NULL
      RETURNING "id"
    `)) as [{ id: string }[], number];

    // Partial: only completed rows are ever queried by this column, and the
    // reporting predicate is always a bounded range over it.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lesson_progress_completed_at"
          ON "lesson_progress" ("completed_at")
       WHERE "completed_at" IS NOT NULL
    `);

    /* ------------------------------ parent_reports --------------------------- */

    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "parent_reports_report_type_enum" AS ENUM ('weekly', 'monthly');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "parent_reports_status_enum" AS ENUM
          ('pending', 'generated', 'dispatched', 'skipped', 'failed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "parent_reports" (
        "id"              uuid NOT NULL DEFAULT uuid_generate_v4(),
        "student_id"      uuid NOT NULL,
        "report_type"     "parent_reports_report_type_enum" NOT NULL,
        "period_key"      character varying(32) NOT NULL,
        "period_start"    TIMESTAMP WITH TIME ZONE NOT NULL,
        "period_end"      TIMESTAMP WITH TIME ZONE NOT NULL,
        "time_zone"       character varying(64) NOT NULL,
        "status"          "parent_reports_status_enum" NOT NULL DEFAULT 'pending',
        "payload"         jsonb,
        "recipient_count" integer NOT NULL DEFAULT 0,
        "generated_at"    TIMESTAMP WITH TIME ZONE,
        "dispatched_at"   TIMESTAMP WITH TIME ZONE,
        "error_message"   text,
        "created_at"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_parent_reports" PRIMARY KEY ("id"),
        CONSTRAINT "FK_parent_reports_student"
          FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    // THE idempotency guarantee. Everything else about duplicate suppression in
    // this feature is an optimisation layered on top of this one constraint.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_parent_reports_student_type_period"
          ON "parent_reports" ("student_id", "report_type", "period_start", "period_end")
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_parent_reports_student"
          ON "parent_reports" ("student_id")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_parent_reports_status"
          ON "parent_reports" ("status")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_parent_reports_type_period"
          ON "parent_reports" ("report_type", "period_start")
    `);

    /* --------------------- indexes supporting the aggregator ----------------- */

    // Every aggregate query is (student_id, <time column> range). Without these
    // a month-end sweep degenerates into a sequential scan per student.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lesson_sessions_student_entered"
          ON "lesson_sessions" ("student_id", "entered_at")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_attendance_student_marked_at"
          ON "attendance_records" ("student_id", "marked_at")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_exam_attempts_student_graded_at"
          ON "exam_attempts" ("student_id", "graded_at")
       WHERE "graded_at" IS NOT NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_homework_submissions_student_submitted"
          ON "homework_submissions" ("student_id", "submitted_at")
    `);

    // eslint-disable-next-line no-console
    console.log(
      `[DEF-006] Created parent_reports. Backfilled completed_at on ${String(backfilledCount)} ` +
        `already-completed lesson_progress row(s) from updated_at (see migration docblock for the ` +
        `documented limitation).`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_homework_submissions_student_submitted"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_exam_attempts_student_graded_at"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_attendance_student_marked_at"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_lesson_sessions_student_entered"`);

    await q.query(`DROP TABLE IF EXISTS "parent_reports"`);
    await q.query(`DROP TYPE IF EXISTS "parent_reports_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "parent_reports_report_type_enum"`);

    await q.query(`DROP INDEX IF EXISTS "IDX_lesson_progress_completed_at"`);
    await q.query(`ALTER TABLE "lesson_progress" DROP COLUMN IF EXISTS "completed_at"`);
  }
}
