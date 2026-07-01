import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bunny Stream direct-upload metadata (additive).
 *
 * The platform now uploads videos straight to Bunny Stream (TUS resumable
 * upload) instead of pasting an embed URL. We persist only Bunny metadata:
 * the encoding lifecycle status plus the resolution / poster / size that Bunny
 * reports once transcoding finishes. `bunny_video_id` / `bunny_library_id`
 * already exist; these columns complete the stored metadata set.
 */
export class AddBunnyStreamVideoMetadata1768640000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "lessons"
         ADD COLUMN "bunny_video_status" character varying(20),
         ADD COLUMN "video_width" integer,
         ADD COLUMN "video_height" integer,
         ADD COLUMN "video_thumbnail" character varying(500),
         ADD COLUMN "video_size_bytes" bigint`,
    );
    // Existing lessons that already have a Bunny video (URL flow) are treated
    // as ready so they remain playable and publishable.
    await q.query(
      `UPDATE "lessons" SET "bunny_video_status" = 'ready'
         WHERE "bunny_video_id" IS NOT NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "lessons"
         DROP COLUMN IF EXISTS "video_size_bytes",
         DROP COLUMN IF EXISTS "video_thumbnail",
         DROP COLUMN IF EXISTS "video_height",
         DROP COLUMN IF EXISTS "video_width",
         DROP COLUMN IF EXISTS "bunny_video_status"`,
    );
  }
}
