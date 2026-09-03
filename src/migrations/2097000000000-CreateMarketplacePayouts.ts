import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fifth marketplace migration (plan.md §3 migration 5 of 8). Payout
 * accounts and payout requests (data-model.md §4). FR-210/FR-211 locking is
 * enforced at the service layer with `SELECT ... FOR UPDATE`, not here.
 */
export class CreateMarketplacePayouts2097000000000 implements MigrationInterface {
  public name = 'CreateMarketplacePayouts2097000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_payout_accounts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "instructor_id" uuid NOT NULL,
        "account_holder_name" character varying(200) NOT NULL,
        "bank_name" character varying(200) NOT NULL,
        "account_identifier_encrypted" text NOT NULL,
        "account_identifier_last4" character varying(4) NOT NULL,
        "currency" character(3) NOT NULL,
        "country" character(2) NOT NULL,
        "verification_status" character varying(20) NOT NULL DEFAULT 'pending',
        "is_default" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "PK_mp_payout_accounts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mp_payout_accounts_instructor" FOREIGN KEY ("instructor_id")
          REFERENCES "marketplace_instructors" ("id") ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_mp_payout_accounts_default"
        ON "marketplace_payout_accounts" ("instructor_id", "currency")
        WHERE "is_default" = true AND "deleted_at" IS NULL;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_payout_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "request_number" character varying(40) NOT NULL,
        "instructor_id" uuid NOT NULL,
        "payout_account_id" uuid NOT NULL,
        "amount_minor" bigint NOT NULL,
        "currency" character(3) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'requested',
        "idempotency_key" character varying(180) NOT NULL,
        "payout_reference" character varying(180),
        "decided_by" uuid,
        "reason" text,
        "requested_at" timestamptz NOT NULL DEFAULT now(),
        "approved_at" timestamptz,
        "processing_at" timestamptz,
        "paid_at" timestamptz,
        "failed_at" timestamptz,
        CONSTRAINT "PK_mp_payout_requests" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_payout_requests_number" UNIQUE ("request_number"),
        CONSTRAINT "UQ_mp_payout_requests_idempotency" UNIQUE ("idempotency_key"),
        CONSTRAINT "FK_mp_payout_requests_instructor" FOREIGN KEY ("instructor_id")
          REFERENCES "marketplace_instructors" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_payout_requests_account" FOREIGN KEY ("payout_account_id")
          REFERENCES "marketplace_payout_accounts" ("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_mp_payouts_amount_positive" CHECK ("amount_minor" > 0),
        CONSTRAINT "CHK_mp_payouts_paid_reference"
          CHECK ("status" <> 'paid' OR "payout_reference" IS NOT NULL),
        CONSTRAINT "CHK_mp_payouts_reject_reason"
          CHECK ("status" NOT IN ('rejected','failed') OR "reason" IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS "IDX_mp_payouts_queue"
        ON "marketplace_payout_requests" ("status", "requested_at");
      CREATE INDEX IF NOT EXISTS "IDX_mp_payouts_instructor"
        ON "marketplace_payout_requests" ("instructor_id", "status");
    `);

    // marketplace_instructor_earnings.payout_request_id and
    // marketplace_ledger_entries.payout_request_id were declared before this
    // table existed (both point forward to the payout request that will
    // eventually claim them); add the FKs now that the referenced table
    // exists. Guarded so re-running this migration's up() is a no-op rather
    // than an "already exists" error.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_mp_earnings_payout_request'
        ) THEN
          ALTER TABLE "marketplace_instructor_earnings"
            ADD CONSTRAINT "FK_mp_earnings_payout_request" FOREIGN KEY ("payout_request_id")
            REFERENCES "marketplace_payout_requests" ("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_mp_ledger_payout_request'
        ) THEN
          ALTER TABLE "marketplace_ledger_entries"
            ADD CONSTRAINT "FK_mp_ledger_payout_request" FOREIGN KEY ("payout_request_id")
            REFERENCES "marketplace_payout_requests" ("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "marketplace_ledger_entries"
        DROP CONSTRAINT IF EXISTS "FK_mp_ledger_payout_request";
      ALTER TABLE "marketplace_instructor_earnings"
        DROP CONSTRAINT IF EXISTS "FK_mp_earnings_payout_request";
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_payout_requests"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_payout_accounts"`);
  }
}
