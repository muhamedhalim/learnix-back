import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Course CMS foundation (Phase 1a) — additive & backward-compatible.
 *
 * Evolves "lesson packages" into "courses" without duplicating models:
 *  - course status / featured / category / tags / estimated_duration
 *  - per-lesson publishing status
 *  - optional chapters (course_chapters) + chapter_id on package items
 *
 * Existing rows are backfilled so current behaviour is preserved (active
 * packages → published, all existing lessons → published).
 */
export class AddCourseCmsFoundation1768628000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ── Enum types ──────────────────────────────────────────────────────────
    await q.query(
      `CREATE TYPE "lesson_packages_status_enum" AS ENUM ('draft','published','hidden','archived')`,
    );
    await q.query(
      `CREATE TYPE "lessons_status_enum" AS ENUM ('draft','published','hidden')`,
    );

    // ── lesson_packages → course CMS columns ────────────────────────────────
    await q.query(
      `ALTER TABLE "lesson_packages"
         ADD COLUMN "status" "lesson_packages_status_enum" NOT NULL DEFAULT 'draft',
         ADD COLUMN "featured" boolean NOT NULL DEFAULT false,
         ADD COLUMN "category" varchar(100),
         ADD COLUMN "tags" text[],
         ADD COLUMN "estimated_duration" integer`,
    );
    // Preserve current visibility: active → published, inactive → draft.
    await q.query(
      `UPDATE "lesson_packages"
         SET "status" = CASE WHEN "is_active" = true
           THEN 'published'::lesson_packages_status_enum
           ELSE 'draft'::lesson_packages_status_enum END`,
    );
    await q.query(
      `CREATE INDEX "IDX_lesson_packages_status" ON "lesson_packages" ("status")`,
    );

    // ── lessons publishing status ───────────────────────────────────────────
    await q.query(
      `ALTER TABLE "lessons" ADD COLUMN "status" "lessons_status_enum" NOT NULL DEFAULT 'published'`,
    );
    await q.query(
      `CREATE INDEX "IDX_lessons_status" ON "lessons" ("status")`,
    );

    // ── course_chapters table ───────────────────────────────────────────────
    await q.query(
      `CREATE TABLE "course_chapters" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "package_id" uuid NOT NULL,
         "title" varchar(255) NOT NULL,
         "order_index" integer NOT NULL DEFAULT 0,
         "created_at" timestamptz NOT NULL DEFAULT now(),
         "updated_at" timestamptz NOT NULL DEFAULT now(),
         "deleted_at" timestamptz,
         CONSTRAINT "PK_course_chapters" PRIMARY KEY ("id"),
         CONSTRAINT "FK_course_chapters_package" FOREIGN KEY ("package_id")
           REFERENCES "lesson_packages"("id") ON DELETE CASCADE
       )`,
    );
    await q.query(
      `CREATE INDEX "IDX_course_chapters_package_id" ON "course_chapters" ("package_id")`,
    );

    // ── lesson_package_items.chapter_id (optional grouping) ─────────────────
    await q.query(`ALTER TABLE "lesson_package_items" ADD COLUMN "chapter_id" uuid`);
    await q.query(
      `CREATE INDEX "IDX_lesson_package_items_chapter_id" ON "lesson_package_items" ("chapter_id")`,
    );
    await q.query(
      `ALTER TABLE "lesson_package_items"
         ADD CONSTRAINT "FK_lesson_package_items_chapter" FOREIGN KEY ("chapter_id")
         REFERENCES "course_chapters"("id") ON DELETE SET NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "lesson_package_items" DROP CONSTRAINT IF EXISTS "FK_lesson_package_items_chapter"`,
    );
    await q.query(`DROP INDEX IF EXISTS "IDX_lesson_package_items_chapter_id"`);
    await q.query(`ALTER TABLE "lesson_package_items" DROP COLUMN IF EXISTS "chapter_id"`);
    await q.query(`DROP TABLE IF EXISTS "course_chapters"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_lessons_status"`);
    await q.query(`ALTER TABLE "lessons" DROP COLUMN IF EXISTS "status"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_lesson_packages_status"`);
    await q.query(
      `ALTER TABLE "lesson_packages"
         DROP COLUMN IF EXISTS "estimated_duration",
         DROP COLUMN IF EXISTS "tags",
         DROP COLUMN IF EXISTS "category",
         DROP COLUMN IF EXISTS "featured",
         DROP COLUMN IF EXISTS "status"`,
    );
    await q.query(`DROP TYPE IF EXISTS "lessons_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "lesson_packages_status_enum"`);
  }
}
