import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4 — scheduled publishing (additive).
 * `published_at` records when a course went live; `scheduled_publish_at` lets a
 * draft auto-publish at a future time (processed by a cron in PackagesService).
 */
export class AddCourseScheduledPublishing1768630000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "lesson_packages"
         ADD COLUMN "published_at" timestamptz,
         ADD COLUMN "scheduled_publish_at" timestamptz`,
    );
    // Stamp already-published courses so analytics have a value.
    await q.query(
      `UPDATE "lesson_packages" SET "published_at" = "created_at" WHERE "status" = 'published'`,
    );
    await q.query(
      `CREATE INDEX "IDX_lesson_packages_scheduled_publish_at" ON "lesson_packages" ("scheduled_publish_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "IDX_lesson_packages_scheduled_publish_at"`,
    );
    await q.query(
      `ALTER TABLE "lesson_packages"
         DROP COLUMN IF EXISTS "scheduled_publish_at",
         DROP COLUMN IF EXISTS "published_at"`,
    );
  }
}
