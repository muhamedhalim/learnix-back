import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supports the central teacher homework inbox without changing homework data.
 * All indexes mirror actual owner/list, due-date, grading and timeline queries.
 */
export class AddTeacherHomeworkCenterIndexes2010000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lesson_homework_lesson_published_due"
      ON "lesson_homework" ("lesson_id", "published_at", "due_at")
      WHERE "deleted_at" IS NULL
    `);
    // pg_trgm is already enabled by the shared search migration. These two
    // indexes match the teacher inbox's ILIKE title/title_ar predicate.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lesson_homework_title_trgm"
      ON "lesson_homework" USING GIN ("title" gin_trgm_ops)
      WHERE "deleted_at" IS NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lesson_homework_title_ar_trgm"
      ON "lesson_homework" USING GIN ("title_ar" gin_trgm_ops)
      WHERE "deleted_at" IS NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_homework_submissions_homework_status_submitted"
      ON "homework_submissions" ("homework_id", "status", "submitted_at")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_homework_submissions_homework_graded"
      ON "homework_submissions" ("homework_id", "graded_at")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_homework_submissions_homework_graded"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_homework_submissions_homework_status_submitted"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_lesson_homework_title_ar_trgm"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_lesson_homework_title_trgm"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_lesson_homework_lesson_published_due"`);
  }
}
