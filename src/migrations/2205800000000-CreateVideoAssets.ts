import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AWS-hosted lesson videos. One row per uploaded source: the original lives in the private
 * source bucket, MediaConvert writes an HLS ladder + poster to the output bucket, and CloudFront
 * serves it behind signed cookies. `lessons.video_asset_id` links an academic lesson to its asset
 * (marketplace lessons reference `aws:<asset id>` in their existing `video_id` column).
 */
export class CreateVideoAssets2205800000000 implements MigrationInterface {
  public name = 'CreateVideoAssets2205800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "video_assets" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "owner_user_id" uuid NOT NULL,
        "source_bucket" varchar(255) NOT NULL,
        "source_key" varchar(500) NOT NULL,
        "output_bucket" varchar(255) NULL,
        "output_prefix" varchar(500) NULL,
        "status" varchar(12) NOT NULL DEFAULT 'uploaded',
        "mediaconvert_job_id" varchar(100) NULL,
        "duration_seconds" integer NULL,
        "width" integer NULL,
        "height" integer NULL,
        "size_bytes" bigint NULL,
        "thumbnail_key" varchar(500) NULL,
        "error_message" varchar(500) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_video_assets_status" CHECK ("status" IN ('uploaded', 'processing', 'ready', 'failed', 'deleted'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_video_assets_job" ON "video_assets" ("mediaconvert_job_id")
        WHERE "mediaconvert_job_id" IS NOT NULL;
      CREATE INDEX IF NOT EXISTS "IDX_video_assets_status" ON "video_assets" ("status")
        WHERE "status" IN ('uploaded', 'processing');
      CREATE INDEX IF NOT EXISTS "IDX_video_assets_owner" ON "video_assets" ("owner_user_id");

      ALTER TABLE "lessons"
        ADD COLUMN IF NOT EXISTS "video_asset_id" uuid NULL;
      CREATE INDEX IF NOT EXISTS "IDX_lessons_video_asset" ON "lessons" ("video_asset_id")
        WHERE "video_asset_id" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_lessons_video_asset";
      ALTER TABLE "lessons" DROP COLUMN IF EXISTS "video_asset_id";
      DROP TABLE IF EXISTS "video_assets";
    `);
  }
}
