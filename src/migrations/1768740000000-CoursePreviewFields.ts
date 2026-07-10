import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Public course-preview fields: marketing copy on courses + a free-preview flag
 * on lessons (so a teaser lesson is playable before purchase).
 */
export class CoursePreviewFields1768740000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE lesson_packages
        ADD COLUMN IF NOT EXISTS requirements TEXT[],
        ADD COLUMN IF NOT EXISTS what_you_learn TEXT[],
        ADD COLUMN IF NOT EXISTS faq JSONB,
        ADD COLUMN IF NOT EXISTS intro_video_url VARCHAR(500);
    `);
    await queryRunner.query(`
      ALTER TABLE lessons
        ADD COLUMN IF NOT EXISTS is_free_preview BOOLEAN NOT NULL DEFAULT false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE lessons DROP COLUMN IF EXISTS is_free_preview;
    `);
    await queryRunner.query(`
      ALTER TABLE lesson_packages
        DROP COLUMN IF EXISTS requirements,
        DROP COLUMN IF EXISTS what_you_learn,
        DROP COLUMN IF EXISTS faq,
        DROP COLUMN IF EXISTS intro_video_url;
    `);
  }
}
