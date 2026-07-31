import { MigrationInterface, QueryRunner } from 'typeorm';

const ALL_FINANCE_PERMISSIONS = JSON.stringify([
  'refunds.create',
  'refunds.process',
  'refunds.complete',
  'settlements.create',
  'settlements.approve',
  'settlements.pay',
  'reconciliation.run',
  'reconciliation.review',
]);

export class AddFinancePermissions2051000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "finance_permissions" jsonb NOT NULL DEFAULT '${ALL_FINANCE_PERMISSIONS}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "finance_permissions"`);
  }
}
