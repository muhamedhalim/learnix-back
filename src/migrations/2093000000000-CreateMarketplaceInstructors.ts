import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * First marketplace migration (plan.md §3 migration 1 of 8). Creates the
 * instructor application and instructor-capability tables (data-model.md §1).
 * Both are entirely new tables — no existing row anywhere is touched, and
 * `down()` is a clean DROP.
 */
export class CreateMarketplaceInstructors2093000000000 implements MigrationInterface {
  public name = 'CreateMarketplaceInstructors2093000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_instructor_applications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "status" character varying(30) NOT NULL DEFAULT 'draft',
        "display_name" character varying(150) NOT NULL,
        "headline" character varying(200),
        "headline_ar" character varying(200),
        "bio" text,
        "bio_ar" text,
        "years_of_experience" integer NOT NULL DEFAULT 0,
        "education" jsonb NOT NULL DEFAULT '[]',
        "certifications" jsonb NOT NULL DEFAULT '[]',
        "work_experience" jsonb NOT NULL DEFAULT '[]',
        "specializations" jsonb NOT NULL DEFAULT '[]',
        "skills" jsonb NOT NULL DEFAULT '[]',
        "intended_category_ids" uuid[] NOT NULL DEFAULT '{}',
        "portfolio_items" jsonb NOT NULL DEFAULT '[]',
        "professional_links" jsonb NOT NULL DEFAULT '[]',
        "photo_key" character varying(500),
        "document_keys" text[] NOT NULL DEFAULT '{}',
        "reviewed_by" uuid,
        "reviewed_at" timestamptz,
        "decision_reason" text,
        "internal_notes" text,
        "submitted_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_instructor_applications" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mp_applications_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_mp_applications_years_nonneg" CHECK ("years_of_experience" >= 0),
        CONSTRAINT "CHK_mp_applications_reject_reason"
          CHECK ("status" <> 'rejected' OR "decision_reason" IS NOT NULL)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_mp_applications_user_open"
        ON "marketplace_instructor_applications" ("user_id")
        WHERE "status" IN ('draft','submitted','under_review','approved');
      CREATE INDEX IF NOT EXISTS "IDX_mp_applications_status_submitted"
        ON "marketplace_instructor_applications" ("status", "submitted_at");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_instructors" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "application_id" uuid,
        "status" character varying(20) NOT NULL DEFAULT 'approved',
        "slug" character varying(160) NOT NULL,
        "display_name" character varying(150) NOT NULL,
        "headline" character varying(200),
        "headline_ar" character varying(200),
        "bio" text,
        "bio_ar" text,
        "years_of_experience" integer NOT NULL DEFAULT 0,
        "education" jsonb NOT NULL DEFAULT '[]',
        "certifications" jsonb NOT NULL DEFAULT '[]',
        "work_experience" jsonb NOT NULL DEFAULT '[]',
        "specializations" jsonb NOT NULL DEFAULT '[]',
        "skills" jsonb NOT NULL DEFAULT '[]',
        "teaching_category_ids" uuid[] NOT NULL DEFAULT '{}',
        "portfolio_items" jsonb NOT NULL DEFAULT '[]',
        "professional_links" jsonb NOT NULL DEFAULT '[]',
        "photo_key" character varying(500),
        "pending_profile_changes" jsonb,
        "suspension_reason" text,
        "suspended_at" timestamptz,
        "suspended_by" uuid,
        "approved_at" timestamptz NOT NULL DEFAULT now(),
        "approved_by" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "PK_mp_instructors" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_instructors_user_id" UNIQUE ("user_id"),
        CONSTRAINT "UQ_mp_instructors_slug" UNIQUE ("slug"),
        CONSTRAINT "FK_mp_instructors_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_instructors_application" FOREIGN KEY ("application_id")
          REFERENCES "marketplace_instructor_applications" ("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_mp_instructors_suspension_reason"
          CHECK ("status" <> 'suspended' OR "suspension_reason" IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS "IDX_mp_instructors_status"
        ON "marketplace_instructors" ("status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_instructors"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_instructor_applications"`);
  }
}
