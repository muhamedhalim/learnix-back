import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supports the Phase 1 list filters that are applied to large collections.
 * PostgreSQL does not create indexes for foreign-key columns automatically.
 */
export class AddPhaseOneScaleIndexes2062000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_student_profiles_grade_level" ON "student_profiles" ("grade_level")',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_attendance_codes_created_by" ON "attendance_codes" ("created_by")',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_attendance_codes_used_by" ON "attendance_codes" ("used_by")',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_attendance_codes_used_by"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_attendance_codes_created_by"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_student_profiles_grade_level"');
  }
}
