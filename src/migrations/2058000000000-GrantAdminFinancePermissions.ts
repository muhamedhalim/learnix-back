import { MigrationInterface, QueryRunner } from 'typeorm';

const ADMIN_FINANCE_PERMISSIONS = JSON.stringify([
  'refunds.create',
  'refunds.process',
  'refunds.complete',
  'settlements.create',
  'settlements.view',
  'settlements.approve',
  'settlements.pay',
  'settlements.reject',
  'settlements.cancel',
  'reports.view',
  'reports.export',
  'reconciliation.run',
  'reconciliation.review',
]);

/**
 * The platform has one administrative role: `admin`. Finance permissions are
 * capabilities of that role, not a second finance role. This migration fixes
 * existing administrators created before later finance permissions existed,
 * and removes administrative grants from every non-admin row.
 */
export class GrantAdminFinancePermissions2058000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "users" SET "finance_permissions" = '${ADMIN_FINANCE_PERMISSIONS}'::jsonb WHERE "role" = 'admin'`,
    );
    await queryRunner.query(
      `UPDATE "users" SET "finance_permissions" = '[]'::jsonb WHERE "role" <> 'admin'`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "finance_permissions" SET DEFAULT '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Permission history is security-sensitive. A rollback must not restore
    // grants to non-admin users or silently remove a valid admin capability.
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "finance_permissions" SET DEFAULT '[]'::jsonb`,
    );
  }
}
