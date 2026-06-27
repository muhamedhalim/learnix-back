import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIsActiveToAttendanceCodes1768619000000 implements MigrationInterface {
  public name = 'AddIsActiveToAttendanceCodes1768619000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add is_active column to attendance_codes table
    await queryRunner.query(`
      ALTER TABLE "attendance_codes"
      ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true
    `);

    // Add index for filtering by active status
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_attendance_codes_is_active"
      ON "attendance_codes" ("is_active")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove index
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_attendance_codes_is_active"
    `);

    // Remove column
    await queryRunner.query(`
      ALTER TABLE "attendance_codes"
      DROP COLUMN IF EXISTS "is_active"
    `);
  }
}
