import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the school-specific Grade Level model from the two tables that own
 * it. Lessons, books, packages, exams, and teacher responses only projected
 * the subject field; none stores a Grade Level relation or foreign key.
 *
 * The indexes are dropped explicitly before their columns. Existing users and
 * educational-content records are otherwise untouched, so every pre-existing
 * relationship remains valid after this migration.
 */
export class RemoveGradeLevel2071000000000 implements MigrationInterface {
  public name = 'RemoveGradeLevel2071000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_student_profiles_grade_level"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_subjects_grade_level"');
    await queryRunner.query(
      'ALTER TABLE "student_profiles" DROP COLUMN IF EXISTS "grade_level"',
    );
    await queryRunner.query('ALTER TABLE "subjects" DROP COLUMN IF EXISTS "grade_level"');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "grade_level" character varying(50)',
    );
    await queryRunner.query(
      'ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "grade_level" character varying(50) NOT NULL DEFAULT \'grade_12\'',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_student_profiles_grade_level" ON "student_profiles" ("grade_level")',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_subjects_grade_level" ON "subjects" ("grade_level")',
    );
  }
}
