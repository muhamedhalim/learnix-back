import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnforceAttendanceStatuses2064000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "attendance_records" ADD CONSTRAINT "CHK_attendance_records_status" CHECK ("status" IN ('present', 'absent', 'late', 'excused'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "attendance_records" DROP CONSTRAINT "CHK_attendance_records_status"',
    );
  }
}
