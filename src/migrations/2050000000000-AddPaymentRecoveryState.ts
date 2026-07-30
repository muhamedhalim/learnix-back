import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable recovery state for gateway-facing financial work.  The migration is
 * additive, keeps existing rows processable, and uses partial indexes so a
 * crash cannot leave more than one live refund dispatch lease for a refund.
 */
export class AddPaymentRecoveryState2050000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "refund_attempts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "refund_id" uuid NOT NULL,
        "attempt_number" integer NOT NULL,
        "idempotency_key" varchar(180) NOT NULL,
        "status" varchar(40) NOT NULL,
        "provider_request_reference" varchar(180),
        "provider_refund_id" varchar(180),
        "claimed_by" varchar(120),
        "claimed_at" TIMESTAMP WITH TIME ZONE,
        "lease_expires_at" TIMESTAMP WITH TIME ZONE,
        "started_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "next_retry_at" TIMESTAMP WITH TIME ZONE,
        "attempt_count" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_refund_attempts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_refund_attempt_refund_number" UNIQUE ("refund_id", "attempt_number"),
        CONSTRAINT "UQ_refund_attempt_idempotency_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "FK_refund_attempt_refund" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_refund_attempt_provider_refund_id" ON "refund_attempts" ("provider_refund_id") WHERE "provider_refund_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_refund_attempt_active_refund" ON "refund_attempts" ("refund_id") WHERE "status" IN ('claimed', 'sending', 'reconciliation_required')`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_refund_attempt_status_retry" ON "refund_attempts" ("status", "next_retry_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_refund_attempt_refund_status" ON "refund_attempts" ("refund_id", "status")`,
    );

    for (const table of ['payments', 'refunds']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "reconciliation_status" varchar(40) NOT NULL DEFAULT 'pending'`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "reconciliation_attempt_count" integer NOT NULL DEFAULT 0`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "reconciliation_last_attempted_at" TIMESTAMP WITH TIME ZONE`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "reconciliation_next_retry_at" TIMESTAMP WITH TIME ZONE`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "reconciliation_last_provider_error" text`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "reconciliation_quarantine_reason" text`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "reconciliation_quarantined_at" TIMESTAMP WITH TIME ZONE`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "reconciliation_claim_token" varchar(64)`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "reconciliation_lease_expires_at" TIMESTAMP WITH TIME ZONE`,
      );
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_${table}_reconciliation_retry" ON "${table}" ("reconciliation_status", "reconciliation_next_retry_at")`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE "gateway_webhook_events" ADD COLUMN IF NOT EXISTS "lease_token" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "gateway_webhook_events" ADD COLUMN IF NOT EXISTS "claimed_by" varchar(120)`,
    );
    await queryRunner.query(
      `ALTER TABLE "gateway_webhook_events" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "gateway_webhook_events" ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "gateway_webhook_events" ADD COLUMN IF NOT EXISTS "heartbeat_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "gateway_webhook_events" ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "gateway_webhook_events" ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "gateway_webhook_events" ADD COLUMN IF NOT EXISTS "max_attempts" integer NOT NULL DEFAULT 8`,
    );
    await queryRunner.query(
      `ALTER TABLE "gateway_webhook_events" ADD COLUMN IF NOT EXISTS "last_error" text`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_gateway_webhook_lease" ON "gateway_webhook_events" ("status", "next_retry_at", "lease_expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_gateway_webhook_lease"`);
    for (const column of [
      'last_error',
      'max_attempts',
      'attempt_count',
      'next_retry_at',
      'heartbeat_at',
      'lease_expires_at',
      'claimed_at',
      'claimed_by',
      'lease_token',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "gateway_webhook_events" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
    for (const table of ['payments', 'refunds']) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_${table}_reconciliation_retry"`);
      for (const column of [
        'reconciliation_lease_expires_at',
        'reconciliation_claim_token',
        'reconciliation_quarantined_at',
        'reconciliation_quarantine_reason',
        'reconciliation_last_provider_error',
        'reconciliation_next_retry_at',
        'reconciliation_last_attempted_at',
        'reconciliation_attempt_count',
        'reconciliation_status',
      ]) {
        await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`);
      }
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_refund_attempt_provider_refund_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_refund_attempt_active_refund"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_refund_attempt_status_retry"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_refund_attempt_refund_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "refund_attempts"`);
  }
}
