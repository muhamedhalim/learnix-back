import { MigrationInterface, QueryRunner } from 'typeorm';

const NEW_PERMISSIONS = [
  'manual_payments.review',
  'manual_payments.approve',
  'manual_payments.manage_methods',
] as const;

const FULL_FINANCE_PERMISSIONS = JSON.stringify([
  'refunds.create',
  'refunds.process',
  'refunds.complete',
  'manual_payments.review',
  'manual_payments.approve',
  'manual_payments.manage_methods',
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
 * AUD-032: give manual-payment administration its own capabilities instead of
 * borrowing `refunds.complete`.
 *
 * ## Migration policy: no one loses access, no one gains it
 * Every admin who can finalise refunds today is, in practice, the person
 * already running the manual-payment queue — that is precisely why the routes
 * were wired to `refunds.complete`. Granting the three new permissions to
 * exactly that population keeps every existing operator working across the
 * deploy, and grants nothing to anyone who did not already hold the authority.
 *
 * The grant is deliberately scoped to `role = 'admin'` as well: `finance_permissions`
 * is a capability of the admin role (see 2058), and a stray non-admin row
 * carrying a permission must not be silently re-armed by this migration.
 *
 * `jsonb` is a document column, so no type change is required — this is a data
 * migration plus a default update, matching 2057/2058.
 *
 * ## Rollback
 * `down` removes only the three new permissions. It deliberately does not
 * restore `refunds.complete` to anyone: re-granting a money-moving permission
 * during a rollback is exactly the kind of silent privilege escalation this
 * change exists to prevent.
 */
export class SplitManualPaymentPermissions2090000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const permission of NEW_PERMISSIONS) {
      await queryRunner.query(
        `UPDATE "users"
            SET "finance_permissions" = "finance_permissions" || $1::jsonb
          WHERE "role" = 'admin'
            AND "finance_permissions" @> '["refunds.complete"]'::jsonb
            AND NOT ("finance_permissions" @> $1::jsonb)`,
        [JSON.stringify([permission])],
      );
    }

    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "finance_permissions" SET DEFAULT '${FULL_FINANCE_PERMISSIONS}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const permission of NEW_PERMISSIONS) {
      await queryRunner.query(
        `UPDATE "users"
            SET "finance_permissions" = "finance_permissions" - $1
          WHERE "finance_permissions" @> $2::jsonb`,
        [permission, JSON.stringify([permission])],
      );
    }

    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "finance_permissions" SET DEFAULT '[]'::jsonb`,
    );
  }
}
