import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Second marketplace migration (plan.md §3 migration 2 of 8). Categories,
 * courses, sections, lessons, publication versions, admin review decisions
 * and the permanent-removal record (data-model.md §2). All new tables.
 */
export class CreateMarketplaceCatalog2094000000000 implements MigrationInterface {
  public name = 'CreateMarketplaceCatalog2094000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_categories" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "parent_id" uuid,
        "name_en" character varying(150) NOT NULL,
        "name_ar" character varying(150) NOT NULL,
        "description_en" text,
        "description_ar" text,
        "slug" character varying(160) NOT NULL,
        "icon_key" character varying(500),
        "display_order" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_categories" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_categories_slug" UNIQUE ("slug"),
        CONSTRAINT "FK_mp_categories_parent" FOREIGN KEY ("parent_id")
          REFERENCES "marketplace_categories" ("id") ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS "IDX_mp_categories_parent_order"
        ON "marketplace_categories" ("parent_id", "display_order");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_courses" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "instructor_id" uuid NOT NULL,
        "category_id" uuid NOT NULL,
        "slug" character varying(200) NOT NULL,
        "title" character varying(255) NOT NULL,
        "title_ar" character varying(255),
        "summary" character varying(500) NOT NULL,
        "summary_ar" character varying(500),
        "description" text NOT NULL,
        "description_ar" text,
        "level" character varying(20) NOT NULL,
        "language" character varying(10) NOT NULL,
        "price_minor" bigint NOT NULL DEFAULT 0,
        "currency" character(3) NOT NULL,
        "cover_image_key" character varying(500) NOT NULL,
        "promo_video_id" character varying(200),
        "learning_outcomes" text[] NOT NULL DEFAULT '{}',
        "prerequisites" text[] NOT NULL DEFAULT '{}',
        "target_audience" text[] NOT NULL DEFAULT '{}',
        "certificate_enabled" boolean NOT NULL DEFAULT false,
        "status" character varying(30) NOT NULL DEFAULT 'draft',
        "current_version_id" uuid,
        "total_duration_seconds" integer NOT NULL DEFAULT 0,
        "lesson_count" integer NOT NULL DEFAULT 0,
        "first_published_at" timestamptz,
        "last_published_at" timestamptz,
        "removed_at" timestamptz,
        "removed_by" uuid,
        "removal_reason" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "PK_mp_courses" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_courses_slug" UNIQUE ("slug"),
        CONSTRAINT "FK_mp_courses_instructor" FOREIGN KEY ("instructor_id")
          REFERENCES "marketplace_instructors" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_courses_category" FOREIGN KEY ("category_id")
          REFERENCES "marketplace_categories" ("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_mp_courses_price_nonneg" CHECK ("price_minor" >= 0),
        CONSTRAINT "CHK_mp_courses_removed" CHECK (
          "removed_at" IS NULL OR ("status" = 'unpublished' AND "removal_reason" IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS "IDX_mp_courses_public"
        ON "marketplace_courses" ("status", "category_id", "level", "language")
        WHERE "status" = 'published' AND "removed_at" IS NULL;
      CREATE INDEX IF NOT EXISTS "IDX_mp_courses_instructor_status"
        ON "marketplace_courses" ("instructor_id", "status");
      CREATE INDEX IF NOT EXISTS "IDX_mp_courses_review_queue"
        ON "marketplace_courses" ("status", "updated_at")
        WHERE "status" = 'submitted_for_review';
      CREATE INDEX IF NOT EXISTS "IDX_mp_courses_price"
        ON "marketplace_courses" ("currency", "price_minor");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_course_sections" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "course_id" uuid NOT NULL,
        "title" character varying(255) NOT NULL,
        "title_ar" character varying(255),
        "position" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_course_sections" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_sections_course_position" UNIQUE ("course_id", "position"),
        CONSTRAINT "FK_mp_sections_course" FOREIGN KEY ("course_id")
          REFERENCES "marketplace_courses" ("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_course_lessons" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "section_id" uuid NOT NULL,
        "title" character varying(255) NOT NULL,
        "title_ar" character varying(255),
        "position" integer NOT NULL,
        "content_type" character varying(20) NOT NULL,
        "video_id" character varying(200),
        "content_html" text,
        "duration_seconds" integer NOT NULL,
        "is_free_preview" boolean NOT NULL DEFAULT false,
        "is_required_for_completion" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_course_lessons" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_lessons_section_position" UNIQUE ("section_id", "position"),
        CONSTRAINT "FK_mp_lessons_section" FOREIGN KEY ("section_id")
          REFERENCES "marketplace_course_sections" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_mp_lessons_duration_positive" CHECK ("duration_seconds" > 0)
      );
      CREATE INDEX IF NOT EXISTS "IDX_mp_lessons_course_preview"
        ON "marketplace_course_lessons" ("section_id", "is_free_preview");
      CREATE INDEX IF NOT EXISTS "IDX_mp_lessons_required"
        ON "marketplace_course_lessons" ("section_id", "is_required_for_completion");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_course_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "course_id" uuid NOT NULL,
        "version_number" integer NOT NULL,
        "snapshot" jsonb NOT NULL,
        "published_at" timestamptz NOT NULL DEFAULT now(),
        "published_by" uuid NOT NULL,
        CONSTRAINT "PK_mp_course_versions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_versions_course_number" UNIQUE ("course_id", "version_number"),
        CONSTRAINT "FK_mp_versions_course" FOREIGN KEY ("course_id")
          REFERENCES "marketplace_courses" ("id") ON DELETE CASCADE
      );
    `);

    // marketplace_courses.current_version_id was declared before this table
    // existed (courses ↔ versions is a genuine cycle); add the FK now that
    // both sides are present.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_mp_courses_current_version'
        ) THEN
          ALTER TABLE "marketplace_courses" ADD CONSTRAINT "FK_mp_courses_current_version"
            FOREIGN KEY ("current_version_id") REFERENCES "marketplace_course_versions" ("id")
            ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_course_removals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "course_id" uuid NOT NULL,
        "cause" character varying(30) NOT NULL,
        "reason" text NOT NULL,
        "removed_by" uuid NOT NULL,
        "removed_at" timestamptz NOT NULL DEFAULT now(),
        "enrollments_revoked" integer NOT NULL DEFAULT 0,
        "refunds_issued" integer NOT NULL DEFAULT 0,
        "refunds_failed" integer NOT NULL DEFAULT 0,
        "earnings_reversed_minor" bigint NOT NULL DEFAULT 0,
        "currency" character(3),
        "completed_at" timestamptz,
        CONSTRAINT "PK_mp_course_removals" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_course_removals_course" UNIQUE ("course_id"),
        CONSTRAINT "FK_mp_course_removals_course" FOREIGN KEY ("course_id")
          REFERENCES "marketplace_courses" ("id") ON DELETE RESTRICT
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_course_review_decisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "course_id" uuid NOT NULL,
        "decision" character varying(20) NOT NULL,
        "reasons" text[] NOT NULL DEFAULT '{}',
        "item_notes" jsonb NOT NULL DEFAULT '{}',
        "reviewed_by" uuid NOT NULL,
        "reviewed_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_course_review_decisions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mp_course_decisions_course" FOREIGN KEY ("course_id")
          REFERENCES "marketplace_courses" ("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "IDX_mp_course_decisions_course_reviewed"
        ON "marketplace_course_review_decisions" ("course_id", "reviewed_at" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_course_review_decisions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_course_removals"`);
    await queryRunner.query(
      `ALTER TABLE "marketplace_courses" DROP CONSTRAINT IF EXISTS "FK_mp_courses_current_version"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_course_versions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_course_lessons"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_course_sections"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_courses"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_categories"`);
  }
}
