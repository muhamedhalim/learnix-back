import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FR-191, FR-263: a refund must withdraw the learner's review of the
 * refunded course. `CourseReviewStatus` (approved/flagged/rejected)
 * deliberately mirrors the academic reviews module's fixed three-value
 * moderation vocabulary — adding a fourth "withdrawn" status value would
 * overload that vocabulary with a lifecycle concept moderation doesn't
 * need. A separate nullable timestamp keeps `status` untouched (a
 * withdrawn review keeps its last moderation status, in case it is ever
 * un-withdrawn) while still being trivial to filter out of any
 * "visible reviews" query with `withdrawn_at IS NULL`.
 */
export class AddReviewWithdrawnAt2106000000000 implements MigrationInterface {
  public name = 'AddReviewWithdrawnAt2106000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "marketplace_course_reviews"
        ADD COLUMN IF NOT EXISTS "withdrawn_at" timestamptz NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "marketplace_course_reviews"
        DROP COLUMN IF EXISTS "withdrawn_at";
    `);
  }
}
