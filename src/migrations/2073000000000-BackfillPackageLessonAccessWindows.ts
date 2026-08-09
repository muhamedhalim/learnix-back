import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Historic package purchases predate the per-lesson purchase projection that
 * package finalization now writes. Backfill that projection before removing
 * package-level lesson access so every lesson keeps its own access window.
 */
export class BackfillPackageLessonAccessWindows2073000000000 implements MigrationInterface {
  public name = 'BackfillPackageLessonAccessWindows2073000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      INSERT INTO "lesson_purchases" (
        "student_id", "lesson_id", "payment_id", "price_paid",
        "access_granted_at", "access_expires_at", "days_extended",
        "revoked_at", "revocation_reason", "created_at", "updated_at"
      )
      SELECT
        pp."student_id",
        item."lesson_id",
        pp."payment_id",
        0,
        pp."purchased_at",
        date_trunc('day', pp."purchased_at" AT TIME ZONE 'UTC')
          + lesson."available_for_days" * INTERVAL '1 day',
        0,
        pp."revoked_at",
        pp."revocation_reason",
        pp."created_at",
        pp."created_at"
      FROM "package_purchases" pp
      INNER JOIN "lesson_package_items" item ON item."package_id" = pp."package_id"
      INNER JOIN "lessons" lesson ON lesson."id" = item."lesson_id"
      ON CONFLICT ("payment_id", "lesson_id", "student_id") DO NOTHING
    `);
  }

  /**
   * Deliberately retain the audit/access projection on rollback. Removing it
   * would discard historical purchase data and could unexpectedly change
   * student access after a migration rollback.
   */
  public async down(_q: QueryRunner): Promise<void> {}
}
