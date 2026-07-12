import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * i18n content: Arabic siblings for the remaining catalog-content entities,
 * completing the `<field>` / `<field>_ar` parallel-column rollout started by
 * 1810100000000-AddSubjectAndExamSectionArabicColumns. Additive and backward
 * compatible — every column is nullable with no default, so existing rows
 * resolve to the English value until an admin/teacher fills in the Arabic
 * copy (see `LocalizedContentUtil`).
 */
export class AddRemainingArabicContentColumns1810200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "course_chapters"
      ADD COLUMN IF NOT EXISTS "title_ar" character varying(255)
    `);

    await queryRunner.query(`
      ALTER TABLE "lesson_attachments"
      ADD COLUMN IF NOT EXISTS "name_ar" character varying(255)
    `);

    await queryRunner.query(`
      ALTER TABLE "lesson_homework"
      ADD COLUMN IF NOT EXISTS "title_ar" character varying(255),
      ADD COLUMN IF NOT EXISTS "description_ar" text
    `);

    await queryRunner.query(`
      ALTER TABLE "certificate_templates"
      ADD COLUMN IF NOT EXISTS "title_ar" character varying(160),
      ADD COLUMN IF NOT EXISTS "body_ar" text,
      ADD COLUMN IF NOT EXISTS "signature_title_ar" character varying(120)
    `);

    await queryRunner.query(`
      ALTER TABLE "teacher_profiles"
      ADD COLUMN IF NOT EXISTS "bio_ar" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "teacher_profiles" DROP COLUMN IF EXISTS "bio_ar"
    `);
    await queryRunner.query(`
      ALTER TABLE "certificate_templates"
      DROP COLUMN IF EXISTS "title_ar",
      DROP COLUMN IF EXISTS "body_ar",
      DROP COLUMN IF EXISTS "signature_title_ar"
    `);
    await queryRunner.query(`
      ALTER TABLE "lesson_homework"
      DROP COLUMN IF EXISTS "title_ar",
      DROP COLUMN IF EXISTS "description_ar"
    `);
    await queryRunner.query(`
      ALTER TABLE "lesson_attachments" DROP COLUMN IF EXISTS "name_ar"
    `);
    await queryRunner.query(`
      ALTER TABLE "course_chapters" DROP COLUMN IF EXISTS "title_ar"
    `);
  }
}
