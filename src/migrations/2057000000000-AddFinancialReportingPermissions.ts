import { MigrationInterface, QueryRunner } from 'typeorm';

const DEFAULT_FINANCE_PERMISSIONS = JSON.stringify([
  'refunds.create',
  'refunds.process',
  'refunds.complete',
  'settlements.create',
  'settlements.view',
  'settlements.approve',
  'settlements.pay',
  'settlements.reject',
  'settlements.cancel',
  'reconciliation.run',
  'reconciliation.review',
  'reports.view',
  'reports.export',
]);

/**
 * New financial-report permissions are explicit. Existing restricted users
 * keep their exact grants; administrators can add the two report permissions
 * through the existing permission administration path.
 */
export class AddFinancialReportingPermissions2057000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "finance_permissions" SET DEFAULT '${DEFAULT_FINANCE_PERMISSIONS}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "finance_permissions" SET DEFAULT '["refunds.create","refunds.process","refunds.complete","settlements.create","settlements.view","settlements.approve","settlements.pay","settlements.reject","settlements.cancel","reconciliation.run","reconciliation.review"]'::jsonb`,
    );
  }
}
