import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateSubjectsEntity1736445602000 implements MigrationInterface {
  name = 'UpdateSubjectsEntity1736445602000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add new name column
    await queryRunner.query(`
      ALTER TABLE "subjects" ADD COLUMN "name" character varying(255)
    `);

    // Migrate title to name (prefer title over title_ar for English)
    await queryRunner.query(`
      UPDATE "subjects" SET "name" = "title" WHERE "name" IS NULL
    `);

    // Make name NOT NULL
    await queryRunner.query(`
      ALTER TABLE "subjects" ALTER COLUMN "name" SET NOT NULL
    `);

    // Add grade_level column with default
    await queryRunner.query(`
      ALTER TABLE "subjects"
      ADD COLUMN "grade_level" character varying(50) NOT NULL DEFAULT 'grade_12'
    `);

    // Add thumbnail column
    await queryRunner.query(`
      ALTER TABLE "subjects" ADD COLUMN "thumbnail" character varying(500)
    `);

    // Create indexes for new columns
    await queryRunner.query(`
      CREATE INDEX "IDX_subjects_name" ON "subjects" ("name")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_subjects_grade_level" ON "subjects" ("grade_level")
    `);

    // Drop old indexes
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_subjects_title"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_subjects_title_ar"
    `);

    // Drop old columns
    await queryRunner.query(`
      ALTER TABLE "subjects" DROP COLUMN IF EXISTS "title"
    `);

    await queryRunner.query(`
      ALTER TABLE "subjects" DROP COLUMN IF EXISTS "title_ar"
    `);

    await queryRunner.query(`
      ALTER TABLE "subjects" DROP COLUMN IF EXISTS "description_ar"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Add back old columns
    await queryRunner.query(`
      ALTER TABLE "subjects" ADD COLUMN "title" character varying(255)
    `);

    await queryRunner.query(`
      ALTER TABLE "subjects" ADD COLUMN "title_ar" character varying(255)
    `);

    await queryRunner.query(`
      ALTER TABLE "subjects" ADD COLUMN "description_ar" text
    `);

    // Migrate name back to title
    await queryRunner.query(`
      UPDATE "subjects" SET "title" = "name", "title_ar" = "name"
    `);

    await queryRunner.query(`
      ALTER TABLE "subjects" ALTER COLUMN "title" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "subjects" ALTER COLUMN "title_ar" SET NOT NULL
    `);

    // Recreate old indexes
    await queryRunner.query(`
      CREATE INDEX "IDX_subjects_title" ON "subjects" ("title")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_subjects_title_ar" ON "subjects" ("title_ar")
    `);

    // Drop new indexes
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_subjects_name"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_subjects_grade_level"
    `);

    // Drop new columns
    await queryRunner.query(`
      ALTER TABLE "subjects" DROP COLUMN IF EXISTS "name"
    `);

    await queryRunner.query(`
      ALTER TABLE "subjects" DROP COLUMN IF EXISTS "grade_level"
    `);

    await queryRunner.query(`
      ALTER TABLE "subjects" DROP COLUMN IF EXISTS "thumbnail"
    `);
  }
}
