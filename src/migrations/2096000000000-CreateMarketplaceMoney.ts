import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fourth marketplace migration (plan.md §3 migration 4 of 8). The currency
 * registry (FR-325), commission history, instructor earnings, the immutable
 * ledger (FR-162) and refund requests (data-model.md §4).
 *
 * The ledger trigger is exported separately (`up`/`down` call it, and the
 * PostgreSQL e2e spec calls the same function directly) so a test can attach
 * it to the `marketplace_ledger_entries` table without re-running the whole
 * migration against a schema TypeORM `synchronize` has already built.
 */
export class CreateMarketplaceMoney2096000000000 implements MigrationInterface {
  public name = 'CreateMarketplaceMoney2096000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_currencies" (
        "code" character(3) NOT NULL,
        "minor_unit_exponent" smallint NOT NULL,
        "is_enabled" boolean NOT NULL DEFAULT false,
        "min_price_minor" bigint NOT NULL,
        "max_price_minor" bigint NOT NULL,
        "min_payout_minor" bigint NOT NULL,
        "updated_by" uuid,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_currencies" PRIMARY KEY ("code"),
        CONSTRAINT "CHK_mp_currencies_bounds" CHECK (
          "min_price_minor" >= 0 AND "max_price_minor" > "min_price_minor"
          AND "min_payout_minor" > 0
        ),
        CONSTRAINT "CHK_mp_currencies_exponent" CHECK (
          "minor_unit_exponent" BETWEEN 0 AND 4
        )
      );
      INSERT INTO "marketplace_currencies"
        ("code", "minor_unit_exponent", "is_enabled", "min_price_minor", "max_price_minor", "min_payout_minor")
      VALUES ('EGP', 2, true, 5000, 2000000, 50000)
      ON CONFLICT ("code") DO NOTHING;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_commission_settings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "scope" character varying(20) NOT NULL DEFAULT 'platform',
        "scope_ref_id" uuid,
        "rate_bps" integer NOT NULL,
        "currency" character(3),
        "effective_from" timestamptz NOT NULL DEFAULT now(),
        "created_by" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "superseded_at" timestamptz,
        CONSTRAINT "PK_mp_commission_settings" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_mp_commission_rate_range" CHECK ("rate_bps" BETWEEN 0 AND 10000)
      );
      CREATE INDEX IF NOT EXISTS "IDX_mp_commission_scope_effective"
        ON "marketplace_commission_settings" ("scope", "scope_ref_id", "effective_from" DESC);
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_instructor_earnings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "instructor_id" uuid NOT NULL,
        "order_id" uuid NOT NULL,
        "gross_amount_minor" bigint NOT NULL,
        "commission_amount_minor" bigint NOT NULL,
        "net_amount_minor" bigint NOT NULL,
        "currency" character(3) NOT NULL,
        "commission_bps" integer NOT NULL,
        "status" character varying(30) NOT NULL DEFAULT 'pending_earnings',
        "available_at" timestamptz NOT NULL,
        "payout_request_id" uuid,
        "reversed_at" timestamptz,
        "reversal_reason" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_instructor_earnings" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_earnings_order" UNIQUE ("order_id"),
        CONSTRAINT "FK_mp_earnings_instructor" FOREIGN KEY ("instructor_id")
          REFERENCES "marketplace_instructors" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_earnings_order" FOREIGN KEY ("order_id")
          REFERENCES "marketplace_orders" ("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_mp_earnings_split"
          CHECK ("commission_amount_minor" + "net_amount_minor" = "gross_amount_minor")
      );
      CREATE INDEX IF NOT EXISTS "IDX_mp_earnings_clearance"
        ON "marketplace_instructor_earnings" ("status", "available_at")
        WHERE "status" = 'refund_clearance';
      CREATE INDEX IF NOT EXISTS "IDX_mp_earnings_balance"
        ON "marketplace_instructor_earnings" ("instructor_id", "currency", "status");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_ledger_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "instructor_id" uuid NOT NULL,
        "order_id" uuid,
        "entry_type" character varying(40) NOT NULL,
        "amount_minor" bigint NOT NULL,
        "currency" character(3) NOT NULL,
        "direction" character varying(10) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'posted',
        "reference" character varying(180) NOT NULL,
        "source_event_id" character varying(180),
        "source_event_type" character varying(60),
        "payout_request_id" uuid,
        "created_by" uuid,
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_ledger_entries" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_ledger_reference" UNIQUE ("reference"),
        CONSTRAINT "FK_mp_ledger_instructor" FOREIGN KEY ("instructor_id")
          REFERENCES "marketplace_instructors" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_ledger_order" FOREIGN KEY ("order_id")
          REFERENCES "marketplace_orders" ("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_mp_ledger_amount_positive" CHECK ("amount_minor" > 0),
        CONSTRAINT "CHK_mp_ledger_direction" CHECK ("direction" IN ('credit','debit')),
        CONSTRAINT "CHK_mp_ledger_adjustment_reason" CHECK (
          "entry_type" <> 'manual_adjustment'
          OR ("created_by" IS NOT NULL AND "metadata" ? 'reason')
        )
      );
      CREATE INDEX IF NOT EXISTS "IDX_mp_ledger_instructor_currency"
        ON "marketplace_ledger_entries" ("instructor_id", "currency", "created_at");
      CREATE INDEX IF NOT EXISTS "IDX_mp_ledger_order"
        ON "marketplace_ledger_entries" ("order_id");
      CREATE INDEX IF NOT EXISTS "IDX_mp_ledger_type_created"
        ON "marketplace_ledger_entries" ("entry_type", "created_at");
    `);

    await queryRunner.query(CreateMarketplaceMoney2096000000000.ledgerTriggerSql());

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_refund_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "order_id" uuid NOT NULL,
        "enrollment_id" uuid NOT NULL,
        "learner_id" uuid NOT NULL,
        "reason" text NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'requested',
        "is_discretionary" boolean NOT NULL DEFAULT false,
        "is_removal_driven" boolean NOT NULL DEFAULT false,
        "elapsed_days_at_request" integer NOT NULL,
        "progress_bps_at_request" integer NOT NULL,
        "progress_bps_at_processing" integer,
        "eligibility_verdict" jsonb NOT NULL DEFAULT '{}',
        "decided_by" uuid,
        "decided_at" timestamptz,
        "refund_reference" character varying(180),
        "failure_reason" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_refund_requests" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mp_refunds_order" FOREIGN KEY ("order_id")
          REFERENCES "marketplace_orders" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_refunds_enrollment" FOREIGN KEY ("enrollment_id")
          REFERENCES "marketplace_enrollments" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_refunds_learner" FOREIGN KEY ("learner_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_mp_refunds_open_per_order"
        ON "marketplace_refund_requests" ("order_id")
        WHERE "status" IN ('requested','approved','processing');
      CREATE INDEX IF NOT EXISTS "IDX_mp_refunds_queue"
        ON "marketplace_refund_requests" ("status", "created_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_refund_requests"`);
    await queryRunner.query(CreateMarketplaceMoney2096000000000.dropLedgerTriggerSql());
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_ledger_entries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_instructor_earnings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_commission_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_currencies"`);
  }

  /**
   * FR-162: no service, migration, or manual console session may UPDATE or
   * DELETE a posted ledger entry. Exported so a PostgreSQL e2e spec can
   * attach the trigger to a table `synchronize` already created without
   * re-running the CREATE TABLE half of this migration.
   */
  public static ledgerTriggerSql(): string {
    return `
      CREATE OR REPLACE FUNCTION mp_prevent_ledger_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'marketplace_ledger_entries is immutable: % is not permitted (FR-162)', TG_OP;
      END;
      $$;
      DROP TRIGGER IF EXISTS "TRG_mp_ledger_immutable" ON "marketplace_ledger_entries";
      CREATE TRIGGER "TRG_mp_ledger_immutable"
      BEFORE UPDATE OR DELETE ON "marketplace_ledger_entries"
      FOR EACH ROW EXECUTE FUNCTION mp_prevent_ledger_mutation();
    `;
  }

  public static dropLedgerTriggerSql(): string {
    return `
      DROP TRIGGER IF EXISTS "TRG_mp_ledger_immutable" ON "marketplace_ledger_entries";
      DROP FUNCTION IF EXISTS mp_prevent_ledger_mutation();
    `;
  }
}
