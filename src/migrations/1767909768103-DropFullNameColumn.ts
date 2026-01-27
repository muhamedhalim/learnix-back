import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DropFullNameColumn1767909768103 implements MigrationInterface {
  public name = 'DropFullNameColumn1767909768103';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop full_name column that's causing conflicts
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "full_name";
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore full_name column
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "full_name" character varying;
    `);
  }
}
