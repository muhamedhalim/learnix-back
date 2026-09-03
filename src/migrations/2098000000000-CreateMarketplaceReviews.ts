import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sixth marketplace migration (plan.md §3 migration 6 of 8). Course reviews
 * and abuse reports against them (data-model.md §5).
 */
export class CreateMarketplaceReviews2098000000000 implements MigrationInterface {
  public name = 'CreateMarketplaceReviews2098000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_course_reviews" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "course_id" uuid NOT NULL,
        "enrollment_id" uuid NOT NULL,
        "learner_id" uuid NOT NULL,
        "rating" integer NOT NULL,
        "comment" text,
        "status" character varying(20) NOT NULL DEFAULT 'approved',
        "instructor_reply" text,
        "instructor_reply_at" timestamptz,
        "report_count" integer NOT NULL DEFAULT 0,
        "moderated_by" uuid,
        "moderation_reason" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_course_reviews" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_reviews_learner_course" UNIQUE ("learner_id", "course_id"),
        CONSTRAINT "FK_mp_reviews_course" FOREIGN KEY ("course_id")
          REFERENCES "marketplace_courses" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_mp_reviews_enrollment" FOREIGN KEY ("enrollment_id")
          REFERENCES "marketplace_enrollments" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_reviews_learner" FOREIGN KEY ("learner_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_mp_reviews_rating" CHECK ("rating" BETWEEN 1 AND 5)
      );
      CREATE INDEX IF NOT EXISTS "IDX_mp_reviews_course_visible"
        ON "marketplace_course_reviews" ("course_id", "status", "created_at" DESC);
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_review_reports" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "review_id" uuid NOT NULL,
        "reporter_id" uuid NOT NULL,
        "reason" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_review_reports" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_review_reports_once" UNIQUE ("review_id", "reporter_id"),
        CONSTRAINT "FK_mp_review_reports_review" FOREIGN KEY ("review_id")
          REFERENCES "marketplace_course_reviews" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_mp_review_reports_reporter" FOREIGN KEY ("reporter_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_review_reports"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_course_reviews"`);
  }
}
