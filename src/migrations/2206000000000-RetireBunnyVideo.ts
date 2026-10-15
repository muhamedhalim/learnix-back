import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retires Bunny Stream from the data model (the "migrate" step of expand -> migrate -> contract).
 *
 * Lesson video is S3 -> MediaConvert -> CloudFront. The application no longer reads or writes any
 * Bunny column, so this migration:
 *
 *   1. refuses to run while a lesson still points at a Bunny-hosted video, unless the operator has
 *      confirmed that those links may be archived (ARCHIVE_LEGACY_BUNNY_VIDEOS=true). The videos
 *      themselves are NOT moved by this migration and nothing is deleted at Bunny: after archiving,
 *      such a lesson has no playable video and its teacher has to upload it again;
 *   2. keeps every Bunny reference in `legacy_bunny_video_references` so a future asset migration (or an
 *      audit) can still find the original ids;
 *   3. renames `lessons.bunny_video_status` to `video_status` (it has held AWS statuses since the
 *      MediaConvert pipeline shipped) and makes `video_platform` optional with no default, because the
 *      application no longer writes it.
 *
 * Contract step (a LATER release, needs database-owner approval, see docs/AWS-PRODUCTION-IMPLEMENTATION-PLAN.md):
 * remove the now-unused `lessons.bunny_video_id`, `bunny_library_id`, `video_platform`, `video_url`,
 * the `lesson_video_upload_sessions` table, and finally `legacy_bunny_video_references` once the
 * Bunny library has been decommissioned.
 */
export class RetireBunnyVideo2206000000000 implements MigrationInterface {
  public name = 'RetireBunnyVideo2206000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const lessonRows = await queryRunner.query(
      `SELECT count(*)::int AS n FROM "lessons"
        WHERE "bunny_video_id" IS NOT NULL AND "video_asset_id" IS NULL`,
    );
    const marketplaceRows = await queryRunner.query(
      `SELECT count(*)::int AS n FROM "marketplace_course_lessons"
        WHERE "video_id" IS NOT NULL AND "video_id" NOT LIKE 'aws:%'`,
    );
    const legacyLessons = Number((lessonRows as Array<{ n: number }>)[0]?.n ?? 0);
    const legacyMarketplace = Number((marketplaceRows as Array<{ n: number }>)[0]?.n ?? 0);

    if (
      legacyLessons + legacyMarketplace > 0 &&
      process.env['ARCHIVE_LEGACY_BUNNY_VIDEOS'] !== 'true'
    ) {
      throw new Error(
        `RetireBunnyVideo: ${legacyLessons} academic lesson(s) and ${legacyMarketplace} marketplace lesson(s) ` +
          'still reference a Bunny-hosted video. Their links will be archived in legacy_bunny_video_references ' +
          'and the lessons will have no video until the teacher uploads it again (nothing is deleted at Bunny). ' +
          'Set ARCHIVE_LEGACY_BUNNY_VIDEOS=true for this migration run to confirm.',
      );
    }

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "legacy_bunny_video_references" (
         "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         "source_table" character varying(64) NOT NULL,
         "source_id" uuid NOT NULL,
         "bunny_video_id" character varying(255) NOT NULL,
         "bunny_library_id" character varying(255),
         "video_url" character varying(500),
         "video_status" character varying(20),
         "archived_at" timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT "UQ_legacy_bunny_video_references_source" UNIQUE ("source_table", "source_id")
       )`,
    );

    if (legacyLessons > 0) {
      await queryRunner.query(
        `INSERT INTO "legacy_bunny_video_references"
           ("source_table", "source_id", "bunny_video_id", "bunny_library_id", "video_url", "video_status")
         SELECT 'lessons', "id", "bunny_video_id", "bunny_library_id", "video_url", "bunny_video_status"
           FROM "lessons"
          WHERE "bunny_video_id" IS NOT NULL AND "video_asset_id" IS NULL
         ON CONFLICT ("source_table", "source_id") DO NOTHING`,
      );
      await queryRunner.query(
        `UPDATE "lessons"
            SET "bunny_video_id" = NULL, "bunny_library_id" = NULL, "video_url" = NULL,
                "bunny_video_status" = NULL, "video_width" = NULL, "video_height" = NULL,
                "video_thumbnail" = NULL, "video_size_bytes" = NULL
          WHERE "bunny_video_id" IS NOT NULL AND "video_asset_id" IS NULL`,
      );
    }

    if (legacyMarketplace > 0) {
      await queryRunner.query(
        `INSERT INTO "legacy_bunny_video_references" ("source_table", "source_id", "bunny_video_id")
         SELECT 'marketplace_course_lessons', "id", "video_id"
           FROM "marketplace_course_lessons"
          WHERE "video_id" IS NOT NULL AND "video_id" NOT LIKE 'aws:%'
         ON CONFLICT ("source_table", "source_id") DO NOTHING`,
      );
      await queryRunner.query(
        `UPDATE "marketplace_course_lessons" SET "video_id" = NULL
          WHERE "video_id" IS NOT NULL AND "video_id" NOT LIKE 'aws:%'`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE "lessons" RENAME COLUMN "bunny_video_status" TO "video_status"`,
    );
    // The application no longer maps this column; a NOT NULL without a default would reject every new lesson.
    await queryRunner.query(
      `ALTER TABLE "lessons" ALTER COLUMN "video_platform" DROP DEFAULT, ALTER COLUMN "video_platform" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "lessons" SET "video_platform" = CASE WHEN "video_asset_id" IS NOT NULL THEN 'aws' ELSE 'bunny' END
        WHERE "video_platform" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "lessons" ALTER COLUMN "video_platform" SET DEFAULT 'bunny', ALTER COLUMN "video_platform" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "lessons" RENAME COLUMN "video_status" TO "bunny_video_status"`,
    );
    // Restore the archived links (the archive itself is kept: it is evidence, not schema).
    await queryRunner.query(
      `UPDATE "lessons" l
          SET "bunny_video_id" = a."bunny_video_id", "bunny_library_id" = a."bunny_library_id",
              "video_url" = a."video_url", "bunny_video_status" = a."video_status"
         FROM "legacy_bunny_video_references" a
        WHERE a."source_table" = 'lessons' AND a."source_id" = l."id"
          AND l."bunny_video_id" IS NULL AND l."video_asset_id" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "marketplace_course_lessons" m SET "video_id" = a."bunny_video_id"
         FROM "legacy_bunny_video_references" a
        WHERE a."source_table" = 'marketplace_course_lessons' AND a."source_id" = m."id"
          AND m."video_id" IS NULL`,
    );
  }
}
