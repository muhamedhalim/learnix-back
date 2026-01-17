import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenamePurchaseCodesToAttendanceCodes1768610000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rename the table
    await queryRunner.query(`
      ALTER TABLE purchase_codes RENAME TO attendance_codes;
    `);

    // Rename all indexes
    await queryRunner.query(`
      ALTER INDEX "IDX_purchase_codes_code"
        RENAME TO "IDX_attendance_codes_code";
    `);

    await queryRunner.query(`
      ALTER INDEX "IDX_purchase_codes_used"
        RENAME TO "IDX_attendance_codes_used";
    `);

    await queryRunner.query(`
      ALTER INDEX "IDX_purchase_codes_expires"
        RENAME TO "IDX_attendance_codes_expires";
    `);

    await queryRunner.query(`
      ALTER INDEX "IDX_purchase_codes_type_item"
        RENAME TO "IDX_attendance_codes_type_item";
    `);

    // Rename foreign key constraints (if they exist with explicit names)
    // Note: TypeORM auto-generated FK names might vary, so we'll handle errors gracefully
    try {
      await queryRunner.query(`
        ALTER TABLE attendance_codes
          RENAME CONSTRAINT "FK_purchase_codes_used_by" TO "FK_attendance_codes_used_by";
      `);
    } catch {
      // FK might not have this exact name, continue anyway
      console.log('FK_purchase_codes_used_by not found, skipping...');
    }

    try {
      await queryRunner.query(`
        ALTER TABLE attendance_codes
          RENAME CONSTRAINT "FK_purchase_codes_created_by" TO "FK_attendance_codes_created_by";
      `);
    } catch {
      // FK might not have this exact name, continue anyway
      console.log('FK_purchase_codes_created_by not found, skipping...');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse: Rename foreign key constraints back
    try {
      await queryRunner.query(`
        ALTER TABLE attendance_codes
          RENAME CONSTRAINT "FK_attendance_codes_created_by" TO "FK_purchase_codes_created_by";
      `);
    } catch {
      console.log('FK_attendance_codes_created_by not found, skipping...');
    }

    try {
      await queryRunner.query(`
        ALTER TABLE attendance_codes
          RENAME CONSTRAINT "FK_attendance_codes_used_by" TO "FK_purchase_codes_used_by";
      `);
    } catch {
      console.log('FK_attendance_codes_used_by not found, skipping...');
    }

    // Reverse: Rename all indexes back
    await queryRunner.query(`
      ALTER INDEX "IDX_attendance_codes_type_item"
        RENAME TO "IDX_purchase_codes_type_item";
    `);

    await queryRunner.query(`
      ALTER INDEX "IDX_attendance_codes_expires"
        RENAME TO "IDX_purchase_codes_expires";
    `);

    await queryRunner.query(`
      ALTER INDEX "IDX_attendance_codes_used"
        RENAME TO "IDX_purchase_codes_used";
    `);

    await queryRunner.query(`
      ALTER INDEX "IDX_attendance_codes_code"
        RENAME TO "IDX_purchase_codes_code";
    `);

    // Reverse: Rename the table back
    await queryRunner.query(`
      ALTER TABLE attendance_codes RENAME TO purchase_codes;
    `);
  }
}
