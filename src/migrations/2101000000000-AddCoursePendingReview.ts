import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FR-071 — a material edit to a `PUBLISHED` course must not reach the
 * public until it passes a new review cycle, while the currently published
 * version (`current_version_id`'s snapshot) stays live throughout. FR-060's
 * transition list has no `published → submitted_for_review` edge, so this
 * cannot be modelled as a status change — `status` stays `published` the
 * whole time. Mirrors the `pending_profile_changes` pattern already used
 * for FR-029: a nullable marker the live row carries alongside its status,
 * not a new lifecycle state.
 *
 * `pending_review_since` doubles as the admin queue's waiting-time
 * timestamp for these courses, the same role `updated_at` plays for the
 * `submitted_for_review` queue (`IDX_mp_courses_review_queue`).
 */
export class AddCoursePendingReview2101000000000 implements MigrationInterface {
  public name = 'AddCoursePendingReview2101000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "marketplace_courses" ADD COLUMN IF NOT EXISTS "pending_review_since" timestamptz;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_mp_courses_pending_review"
        ON "marketplace_courses" ("pending_review_since")
        WHERE "pending_review_since" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_mp_courses_pending_review";
      ALTER TABLE "marketplace_courses" DROP COLUMN IF EXISTS "pending_review_since";
    `);
  }
}
