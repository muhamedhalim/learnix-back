import { MigrationInterface, QueryRunner } from 'typeorm';

/** Durable multi-replica claim state for transactional payment outbox rows. */
export class AddPaymentOutboxLeases2053000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_domain_events" ADD COLUMN IF NOT EXISTS "status" varchar(30) NOT NULL DEFAULT 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_domain_events" ADD COLUMN IF NOT EXISTS "lease_token" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_domain_events" ADD COLUMN IF NOT EXISTS "claimed_by" varchar(120)`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_domain_events" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_domain_events" ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_domain_events" ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_domain_events" ADD COLUMN IF NOT EXISTS "failed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_domain_events" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `UPDATE "payment_domain_events" SET "status" = CASE WHEN "published_at" IS NULL THEN 'pending' ELSE 'published' END`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_domain_events_lease" ON "payment_domain_events" ("status", "next_retry_at", "lease_expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payment_domain_events_lease"`);
    for (const column of [
      'updated_at',
      'failed_at',
      'next_retry_at',
      'lease_expires_at',
      'claimed_at',
      'claimed_by',
      'lease_token',
      'status',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "payment_domain_events" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }
}
