import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrateToBunnyNet1767891201000 implements MigrationInterface {
  name = 'MigrateToBunnyNet1767891201000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // First, rename vimeo_embed_html to vimeo_embed_url to match entity
    await queryRunner.query(`
      ALTER TABLE "lessons" RENAME COLUMN "vimeo_embed_html" TO "vimeo_embed_url"
    `);

    // Add new Bunny.net columns
    await queryRunner.query(`
      ALTER TABLE "lessons" ADD COLUMN IF NOT EXISTS "video_url" character varying(500)
    `);

    await queryRunner.query(`
      ALTER TABLE "lessons" ADD COLUMN IF NOT EXISTS "video_platform" character varying(20) DEFAULT 'bunny'
    `);

    await queryRunner.query(`
      ALTER TABLE "lessons" ADD COLUMN IF NOT EXISTS "bunny_video_id" character varying(255)
    `);

    await queryRunner.query(`
      ALTER TABLE "lessons" ADD COLUMN IF NOT EXISTS "bunny_library_id" character varying(255)
    `);

    // Migrate existing Vimeo data: copy vimeo_embed_url to video_url and set platform to 'vimeo'
    await queryRunner.query(`
      UPDATE "lessons"
      SET
        "video_url" = "vimeo_embed_url",
        "video_platform" = 'vimeo'
      WHERE "vimeo_embed_url" IS NOT NULL
    `);

    // Create index on video_platform for query optimization
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lessons_video_platform" ON "lessons" ("video_platform")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop index
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_lessons_video_platform"
    `);

    // Drop new columns
    await queryRunner.query(`
      ALTER TABLE "lessons" DROP COLUMN IF EXISTS "bunny_library_id"
    `);

    await queryRunner.query(`
      ALTER TABLE "lessons" DROP COLUMN IF EXISTS "bunny_video_id"
    `);

    await queryRunner.query(`
      ALTER TABLE "lessons" DROP COLUMN IF EXISTS "video_platform"
    `);

    await queryRunner.query(`
      ALTER TABLE "lessons" DROP COLUMN IF EXISTS "video_url"
    `);

    // Revert column rename
    await queryRunner.query(`
      ALTER TABLE "lessons" RENAME COLUMN "vimeo_embed_url" TO "vimeo_embed_html"
    `);
  }
}
