import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the professional-profile fields needed for the premium instructor
 * profile page: a bilingual headline title, and four jsonb list/array
 * fields (specializations, languages, skills, education, certificates).
 *
 * All columns are additive with safe defaults (`NOT NULL DEFAULT '[]'` for
 * the jsonb arrays, nullable for the title) so every existing teacher_profiles
 * row is valid immediately with no backfill required.
 */
export class AddTeacherProfileRichFields1840000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "teacher_profiles"
      ADD COLUMN IF NOT EXISTS "professional_title" varchar(150),
      ADD COLUMN IF NOT EXISTS "professional_title_ar" varchar(150),
      ADD COLUMN IF NOT EXISTS "specializations" jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS "languages" jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS "skills" jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS "education" jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS "certificates" jsonb NOT NULL DEFAULT '[]'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "teacher_profiles"
      DROP COLUMN IF EXISTS "professional_title",
      DROP COLUMN IF EXISTS "professional_title_ar",
      DROP COLUMN IF EXISTS "specializations",
      DROP COLUMN IF EXISTS "languages",
      DROP COLUMN IF EXISTS "skills",
      DROP COLUMN IF EXISTS "education",
      DROP COLUMN IF EXISTS "certificates"
    `);
  }
}
