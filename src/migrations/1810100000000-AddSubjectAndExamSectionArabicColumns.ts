import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * i18n content: Arabic siblings for subject taxonomy text and exam section
 * descriptions, following the platform's `<field>` / `<field>_ar` parallel-column
 * convention (see `LocalizedContentUtil`). Additive and backward compatible —
 * every column is nullable with no default, so existing rows resolve to the
 * English value until an admin/teacher fills in the Arabic copy.
 */
export class AddSubjectAndExamSectionArabicColumns1810100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subjects"
      ADD COLUMN IF NOT EXISTS "name_ar" character varying(255),
      ADD COLUMN IF NOT EXISTS "description_ar" text
    `);

    await queryRunner.query(`
      ALTER TABLE "exam_sections"
      ADD COLUMN IF NOT EXISTS "description_ar" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "exam_sections" DROP COLUMN IF EXISTS "description_ar"
    `);
    await queryRunner.query(`
      ALTER TABLE "subjects"
      DROP COLUMN IF EXISTS "name_ar",
      DROP COLUMN IF EXISTS "description_ar"
    `);
  }
}
