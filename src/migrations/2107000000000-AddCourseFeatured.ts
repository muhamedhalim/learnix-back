import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FR-284 (T191): the admin-curated featured set on the public marketplace.
 * `featured_at` (not just a boolean) lets the featured list be ordered by
 * when a course was featured, the same "most-recently-promoted first"
 * ordering an editorial front page naturally wants — a bare boolean would
 * lose that. Nullable so "not featured" needs no sentinel value.
 */
export class AddCourseFeatured2107000000000 implements MigrationInterface {
  public name = 'AddCourseFeatured2107000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "marketplace_courses"
        ADD COLUMN IF NOT EXISTS "featured_at" timestamptz NULL;
      CREATE INDEX IF NOT EXISTS "IDX_mp_courses_featured" ON "marketplace_courses" ("featured_at")
        WHERE "featured_at" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_mp_courses_featured";
      ALTER TABLE "marketplace_courses"
        DROP COLUMN IF EXISTS "featured_at";
    `);
  }
}
