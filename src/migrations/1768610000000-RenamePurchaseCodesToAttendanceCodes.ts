import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RenamePurchaseCodesToAttendanceCodes1768610000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rename the table
    await queryRunner.query(`
      ALTER TABLE purchase_codes RENAME TO attendance_codes;
    `);

    // Rename indexes - check existence first to avoid transaction abortion
    const indexes = [
      { old: 'IDX_purchase_codes_code', new: 'IDX_attendance_codes_code' },
      { old: 'IDX_purchase_codes_used', new: 'IDX_attendance_codes_used' },
      {
        old: 'IDX_purchase_codes_expires',
        new: 'IDX_attendance_codes_expires',
      },
      {
        old: 'IDX_purchase_codes_type_item',
        new: 'IDX_attendance_codes_type_item',
      },
    ];

    for (const { old: oldName, new: newName } of indexes) {
      const exists: unknown = await queryRunner.query(`
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = '${oldName}'
      `);
      if (Array.isArray(exists) && exists.length > 0) {
        await queryRunner.query(
          `ALTER INDEX "${oldName}" RENAME TO "${newName}"`,
        );
      }
    }

    // Rename foreign key constraints - check existence first
    const constraints = [
      {
        old: 'FK_purchase_codes_used_by',
        new: 'FK_attendance_codes_used_by',
      },
      {
        old: 'FK_purchase_codes_created_by',
        new: 'FK_attendance_codes_created_by',
      },
    ];

    for (const { old: oldName, new: newName } of constraints) {
      const exists: unknown = await queryRunner.query(`
        SELECT 1 FROM pg_constraint WHERE conname = '${oldName}'
      `);
      if (Array.isArray(exists) && exists.length > 0) {
        await queryRunner.query(
          `ALTER TABLE attendance_codes RENAME CONSTRAINT "${oldName}" TO "${newName}"`,
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse: Rename foreign key constraints back
    const constraints = [
      {
        old: 'FK_attendance_codes_created_by',
        new: 'FK_purchase_codes_created_by',
      },
      {
        old: 'FK_attendance_codes_used_by',
        new: 'FK_purchase_codes_used_by',
      },
    ];

    for (const { old: oldName, new: newName } of constraints) {
      const exists: unknown = await queryRunner.query(`
        SELECT 1 FROM pg_constraint WHERE conname = '${oldName}'
      `);
      if (Array.isArray(exists) && exists.length > 0) {
        await queryRunner.query(
          `ALTER TABLE attendance_codes RENAME CONSTRAINT "${oldName}" TO "${newName}"`,
        );
      }
    }

    // Reverse: Rename indexes back
    const indexes = [
      {
        old: 'IDX_attendance_codes_type_item',
        new: 'IDX_purchase_codes_type_item',
      },
      {
        old: 'IDX_attendance_codes_expires',
        new: 'IDX_purchase_codes_expires',
      },
      { old: 'IDX_attendance_codes_used', new: 'IDX_purchase_codes_used' },
      { old: 'IDX_attendance_codes_code', new: 'IDX_purchase_codes_code' },
    ];

    for (const { old: oldName, new: newName } of indexes) {
      const exists: unknown = await queryRunner.query(`
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = '${oldName}'
      `);
      if (Array.isArray(exists) && exists.length > 0) {
        await queryRunner.query(
          `ALTER INDEX "${oldName}" RENAME TO "${newName}"`,
        );
      }
    }

    // Reverse: Rename the table back
    await queryRunner.query(`
      ALTER TABLE attendance_codes RENAME TO purchase_codes;
    `);
  }
}
