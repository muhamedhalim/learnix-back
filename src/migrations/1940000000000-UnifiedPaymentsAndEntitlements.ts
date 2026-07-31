import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Introduces the canonical order/payment/entitlement/ledger model without
 * deleting or reinterpreting legacy purchases. Historical collection-party
 * facts are explicitly `unknown`; no historical wallet/commission entries are
 * fabricated. Existing purchase tables remain as access-compatible projections.
 */
export class UnifiedPaymentsAndEntitlements1940000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await q.query(`
      CREATE TABLE "orders" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "order_number" varchar(40) NOT NULL,
        "student_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "teacher_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
        "item_type" varchar(30) NOT NULL CHECK ("item_type" IN ('lesson','package','book')),
        "item_id" uuid NOT NULL,
        "quantity" integer NOT NULL DEFAULT 1 CHECK ("quantity" > 0),
        "original_amount_minor" bigint NOT NULL CHECK ("original_amount_minor" >= 0),
        "discount_amount_minor" bigint NOT NULL DEFAULT 0 CHECK ("discount_amount_minor" >= 0),
        "final_amount_minor" bigint NOT NULL CHECK ("final_amount_minor" >= 0),
        "refunded_amount_minor" bigint NOT NULL DEFAULT 0 CHECK ("refunded_amount_minor" >= 0),
        "currency" char(3) NOT NULL DEFAULT 'EGP',
        "payment_channel" varchar(30) NOT NULL CHECK ("payment_channel" IN ('activation_code','manual','gateway','legacy')),
        "payment_method" varchar(80),
        "status" varchar(30) NOT NULL DEFAULT 'awaiting_payment'
          CHECK ("status" IN ('awaiting_payment','payment_submitted','under_review','paid','rejected','expired','cancelled','partially_refunded','refunded')),
        "discount_code_id" uuid REFERENCES "discount_codes"("id") ON DELETE SET NULL,
        "activation_code_id" uuid,
        "payment_id" uuid,
        "collection_party" varchar(30) NOT NULL DEFAULT 'unknown'
          CHECK ("collection_party" IN ('platform','teacher','center','agent','other','unknown')),
        "product_title_snapshot" varchar(255) NOT NULL,
        "product_title_ar_snapshot" varchar(255),
        "seller_name_snapshot" varchar(255),
        "platform_commission_bps" integer NOT NULL CHECK ("platform_commission_bps" BETWEEN 0 AND 10000),
        "platform_commission_minor" bigint NOT NULL CHECK ("platform_commission_minor" >= 0),
        "teacher_earning_minor" bigint NOT NULL CHECK ("teacher_earning_minor" >= 0),
        "discount_snapshot" jsonb,
        "metadata" jsonb,
        "expires_at" timestamptz,
        "paid_at" timestamptz,
        "cancelled_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_orders_order_number" UNIQUE ("order_number"),
        CONSTRAINT "CHK_orders_discount_not_above_original"
          CHECK ("discount_amount_minor" <= "original_amount_minor"),
        CONSTRAINT "CHK_orders_final_amount"
          CHECK ("final_amount_minor" = "original_amount_minor" - "discount_amount_minor"),
        CONSTRAINT "CHK_orders_refund_not_above_paid"
          CHECK ("refunded_amount_minor" <= "final_amount_minor")
      )
    `);
    await q.query(`CREATE INDEX "IDX_orders_student_status" ON "orders" ("student_id","status")`);
    await q.query(`CREATE INDEX "IDX_orders_teacher_status" ON "orders" ("teacher_id","status")`);
    await q.query(`CREATE INDEX "IDX_orders_item" ON "orders" ("item_type","item_id")`);
    await q.query(
      `CREATE INDEX "IDX_orders_channel_created" ON "orders" ("payment_channel","created_at")`,
    );
    await q.query(`
      CREATE UNIQUE INDEX "UQ_orders_active_student_item"
      ON "orders" ("student_id","item_type","item_id")
      WHERE "status" IN ('awaiting_payment','payment_submitted','under_review')
    `);

    // Complete the payments/orders relationship before either table is backfilled.
    // This avoids PostgreSQL pending FK trigger events when a later ALTER TABLE
    // targets a table that has already been changed in the same transaction.
    await q.query(`ALTER TYPE "payments_payment_method_enum" ADD VALUE IF NOT EXISTS 'manual'`);
    await q.query(`ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "order_id" uuid`);
    await q.query(`ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "amount_minor" bigint`);
    await q.query(
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "channel" varchar(30) NOT NULL DEFAULT 'legacy'`,
    );
    await q.query(`ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "provider" varchar(60)`);
    await q.query(
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "provider_reference" varchar(255)`,
    );
    await q.query(`ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "completed_at" timestamptz`);
    await q.query(
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "currency" char(3) NOT NULL DEFAULT 'EGP'`,
    );
    await q.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "CHK_payments_amount_minor_nonnegative" CHECK ("amount_minor" IS NULL OR "amount_minor" >= 0)`,
    );
    await q.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_payments_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_payments_order_id" ON "payments" ("order_id") WHERE "order_id" IS NOT NULL`,
    );
    await q.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_payment" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED`,
    );
    // activation_code_id is nullable and no legacy source populates it during
    // this migration, so every pre-backfill value is NULL and therefore valid.
    await q.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_activation_code" FOREIGN KEY ("activation_code_id") REFERENCES "attendance_codes"("id") ON DELETE RESTRICT`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_orders_activation_code" ON "orders" ("activation_code_id") WHERE "activation_code_id" IS NOT NULL`,
    );

    await q.query(
      `UPDATE "payments" SET "amount_minor" = ROUND("final_amount" * 100)::bigint WHERE "amount_minor" IS NULL`,
    );

    await q.query(`
      INSERT INTO "orders" (
        "order_number", "student_id", "teacher_id", "item_type", "item_id",
        "original_amount_minor", "discount_amount_minor", "final_amount_minor",
        "refunded_amount_minor", "currency", "payment_channel", "payment_method",
        "status", "collection_party", "product_title_snapshot",
        "product_title_ar_snapshot", "seller_name_snapshot",
        "platform_commission_bps", "platform_commission_minor",
        "teacher_earning_minor", "metadata", "paid_at", "expires_at",
        "created_at", "updated_at"
      )
      SELECT
        'LX-LEGACY-' || upper(substr(replace(p."id"::text, '-', ''), 1, 16)),
        p."user_id",
        CASE p."item_type"::text
          WHEN 'lesson' THEN (SELECT l."teacher_id" FROM "lessons" l WHERE l."id" = p."item_id")
          WHEN 'package' THEN (SELECT lp."teacher_id" FROM "lesson_packages" lp WHERE lp."id" = p."item_id")
          WHEN 'book' THEN (SELECT b."teacher_id" FROM "books" b WHERE b."id" = p."item_id")
        END,
        p."item_type"::text,
        p."item_id",
        ROUND(p."amount" * 100)::bigint,
        ROUND(p."discount_amount" * 100)::bigint,
        ROUND(p."final_amount" * 100)::bigint,
        CASE WHEN p."status"::text = 'refunded' THEN ROUND(p."final_amount" * 100)::bigint ELSE 0 END,
        COALESCE(p."currency", 'EGP'),
        'legacy',
        p."payment_method"::text,
        CASE p."status"::text
          WHEN 'completed' THEN 'paid'
          WHEN 'refunded' THEN 'refunded'
          WHEN 'expired' THEN 'expired'
          WHEN 'failed' THEN 'rejected'
          ELSE 'cancelled'
        END,
        'unknown',
        COALESCE(
          CASE p."item_type"::text
            WHEN 'lesson' THEN (SELECT l."title" FROM "lessons" l WHERE l."id" = p."item_id")
            WHEN 'package' THEN (SELECT lp."title" FROM "lesson_packages" lp WHERE lp."id" = p."item_id")
            WHEN 'book' THEN (SELECT b."title" FROM "books" b WHERE b."id" = p."item_id")
          END,
          'Legacy purchase'
        ),
        CASE p."item_type"::text
          WHEN 'lesson' THEN (SELECT l."title" FROM "lessons" l WHERE l."id" = p."item_id")
          WHEN 'package' THEN (SELECT lp."title_ar" FROM "lesson_packages" lp WHERE lp."id" = p."item_id")
          WHEN 'book' THEN (SELECT b."title_ar" FROM "books" b WHERE b."id" = p."item_id")
        END,
        CASE p."item_type"::text
          WHEN 'lesson' THEN (SELECT u."name" FROM "lessons" l JOIN "users" u ON u."id" = l."teacher_id" WHERE l."id" = p."item_id")
          WHEN 'package' THEN (SELECT u."name" FROM "lesson_packages" lp JOIN "users" u ON u."id" = lp."teacher_id" WHERE lp."id" = p."item_id")
          WHEN 'book' THEN (SELECT u."name" FROM "books" b JOIN "users" u ON u."id" = b."teacher_id" WHERE b."id" = p."item_id")
        END,
        0,
        0,
        0,
        jsonb_build_object(
          'legacy_payment_id', p."id",
          'financial_allocation', 'unknown_not_backfilled',
          'requires_financial_review', true
        ),
        CASE WHEN p."status"::text IN ('completed','refunded') THEN p."updated_at" ELSE NULL END,
        CASE WHEN p."status"::text IN ('pending','processing') THEN p."created_at" + interval '1 hour' ELSE NULL END,
        p."created_at",
        p."updated_at"
      FROM "payments" p
      WHERE p."order_id" IS NULL
    `);
    await q.query(`
      UPDATE "payments" p
      SET "order_id" = o."id",
          "channel" = 'legacy',
          "completed_at" = CASE WHEN p."status"::text = 'completed' THEN p."updated_at" ELSE p."completed_at" END
      FROM "orders" o
      WHERE o."metadata"->>'legacy_payment_id' = p."id"::text
    `);
    await q.query(
      `UPDATE "orders" o SET "payment_id" = p."id" FROM "payments" p WHERE p."order_id" = o."id"`,
    );

    await q.query(`
      CREATE TABLE "entitlements" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "student_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "item_type" varchar(30) NOT NULL CHECK ("item_type" IN ('lesson','package','book')),
        "item_id" uuid NOT NULL,
        "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
        "payment_id" uuid REFERENCES "payments"("id") ON DELETE RESTRICT,
        "source_channel" varchar(30) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','expired','revoked')),
        "granted_at" timestamptz NOT NULL,
        "starts_at" timestamptz NOT NULL,
        "expires_at" timestamptz,
        "revoked_at" timestamptz,
        "revocation_reason" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_entitlements_order" UNIQUE ("order_id"),
        CONSTRAINT "UQ_entitlements_order_product_student" UNIQUE ("order_id","student_id","item_type","item_id")
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_entitlements_student_item_status" ON "entitlements" ("student_id","item_type","item_id","status")`,
    );
    await q.query(`CREATE INDEX "IDX_entitlements_expires_at" ON "entitlements" ("expires_at")`);
    await q.query(`
      INSERT INTO "entitlements" (
        "student_id","item_type","item_id","order_id","payment_id",
        "source_channel","status","granted_at","starts_at","expires_at"
      )
      SELECT
        o."student_id", o."item_type", o."item_id", o."id", o."payment_id",
        o."payment_channel",
        CASE WHEN o."status" = 'paid' THEN 'active' ELSE 'revoked' END,
        COALESCE(o."paid_at", o."created_at"),
        COALESCE(o."paid_at", o."created_at"),
        CASE WHEN o."item_type" = 'lesson' THEN (
          SELECT max(lp."access_expires_at")
          FROM "lesson_purchases" lp
          WHERE lp."payment_id" = o."payment_id" AND lp."lesson_id" = o."item_id"
        ) ELSE NULL END
      FROM "orders" o
      WHERE o."status" IN ('paid','refunded')
      ON CONFLICT ("order_id") DO NOTHING
    `);

    await q.query(
      `ALTER TABLE "lesson_purchases" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz`,
    );
    await q.query(
      `ALTER TABLE "lesson_purchases" ADD COLUMN IF NOT EXISTS "revocation_reason" text`,
    );
    await q.query(
      `ALTER TABLE "package_purchases" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz`,
    );
    await q.query(
      `ALTER TABLE "package_purchases" ADD COLUMN IF NOT EXISTS "revocation_reason" text`,
    );
    await q.query(`ALTER TABLE "book_purchases" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz`);
    await q.query(`ALTER TABLE "book_purchases" ADD COLUMN IF NOT EXISTS "revocation_reason" text`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lesson_purchases_payment_lesson_student" ON "lesson_purchases" ("payment_id","lesson_id","student_id")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_package_purchases_payment_package_student" ON "package_purchases" ("payment_id","package_id","student_id")`,
    );
    await q.query(`DROP INDEX IF EXISTS "IDX_book_purchases_student_book"`);
    await q.query(
      `CREATE UNIQUE INDEX "IDX_book_purchases_student_book" ON "book_purchases" ("student_id","book_id") WHERE "revoked_at" IS NULL`,
    );

    await q.query(`
      CREATE TABLE "manual_payment_methods" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "name" varchar(120) NOT NULL,
        "name_ar" varchar(120) NOT NULL,
        "type" varchar(40) NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "display_order" integer NOT NULL DEFAULT 0,
        "recipient_name" varchar(160) NOT NULL,
        "destination_details" jsonb NOT NULL,
        "instructions" text NOT NULL,
        "instructions_ar" text NOT NULL,
        "qr_file_key" varchar(500),
        "minimum_amount_minor" bigint,
        "maximum_amount_minor" bigint,
        "currency" char(3) NOT NULL DEFAULT 'EGP',
        "order_expiration_minutes" integer NOT NULL DEFAULT 1440 CHECK ("order_expiration_minutes" BETWEEN 5 AND 43200),
        "proof_required" boolean NOT NULL DEFAULT true,
        "reference_required" boolean NOT NULL DEFAULT true,
        "countries" jsonb,
        "collection_party" varchar(30) NOT NULL DEFAULT 'platform',
        "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "updated_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_manual_method_limits" CHECK (
          ("minimum_amount_minor" IS NULL OR "minimum_amount_minor" >= 0)
          AND ("maximum_amount_minor" IS NULL OR "maximum_amount_minor" > 0)
          AND ("minimum_amount_minor" IS NULL OR "maximum_amount_minor" IS NULL OR "minimum_amount_minor" <= "maximum_amount_minor")
        )
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_manual_payment_methods_enabled_order" ON "manual_payment_methods" ("enabled","display_order")`,
    );

    await q.query(`
      CREATE TABLE "manual_payment_submissions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
        "student_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "manual_payment_method_id" uuid NOT NULL REFERENCES "manual_payment_methods"("id") ON DELETE RESTRICT,
        "claimed_amount_minor" bigint NOT NULL CHECK ("claimed_amount_minor" > 0),
        "currency" char(3) NOT NULL,
        "payer_name" varchar(160) NOT NULL,
        "payer_account_hint" varchar(32),
        "transaction_reference" varchar(160),
        "paid_at_claimed" timestamptz,
        "proof_file_key" varchar(500),
        "proof_sha256" char(64),
        "proof_mime_type" varchar(100),
        "student_note" text,
        "status" varchar(40) NOT NULL DEFAULT 'submitted'
          CHECK ("status" IN ('submitted','under_review','more_information_required','approved','rejected','cancelled')),
        "submitted_at" timestamptz NOT NULL,
        "reviewed_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
        "reviewed_at" timestamptz,
        "rejection_reason_code" varchar(60),
        "rejection_reason" text,
        "reviewer_note" text,
        "revision_count" integer NOT NULL DEFAULT 0,
        "metadata" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_manual_submissions_status_submitted" ON "manual_payment_submissions" ("status","submitted_at")`,
    );
    await q.query(
      `CREATE INDEX "IDX_manual_submissions_order" ON "manual_payment_submissions" ("order_id")`,
    );
    await q.query(
      `CREATE INDEX "IDX_manual_submissions_student" ON "manual_payment_submissions" ("student_id")`,
    );
    await q.query(
      `CREATE INDEX "IDX_manual_submissions_reference" ON "manual_payment_submissions" ("manual_payment_method_id","transaction_reference")`,
    );
    await q.query(
      `CREATE INDEX "IDX_manual_submissions_proof_hash" ON "manual_payment_submissions" ("proof_sha256")`,
    );
    await q.query(`
      CREATE UNIQUE INDEX "UQ_manual_approved_reference"
      ON "manual_payment_submissions" ("manual_payment_method_id","transaction_reference")
      WHERE "status" = 'approved' AND "transaction_reference" IS NOT NULL
    `);

    await q.query(`
      CREATE TABLE "financial_ledger_entries" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "account" varchar(80) NOT NULL,
        "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
        "payment_id" uuid REFERENCES "payments"("id") ON DELETE RESTRICT,
        "teacher_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
        "entry_type" varchar(50) NOT NULL,
        "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
        "currency" char(3) NOT NULL,
        "direction" varchar(10) NOT NULL CHECK ("direction" IN ('debit','credit')),
        "status" varchar(20) NOT NULL DEFAULT 'posted',
        "available_at" timestamptz,
        "source_channel" varchar(30) NOT NULL,
        "collection_party" varchar(30) NOT NULL,
        "reference" varchar(180) NOT NULL,
        "settlement_id" uuid,
        "metadata" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_financial_ledger_reference" UNIQUE ("reference")
      )
    `);
    await q.query(`CREATE INDEX "IDX_ledger_order" ON "financial_ledger_entries" ("order_id")`);
    await q.query(
      `CREATE INDEX "IDX_ledger_teacher_created" ON "financial_ledger_entries" ("teacher_id","created_at")`,
    );
    await q.query(
      `CREATE INDEX "IDX_ledger_account_currency" ON "financial_ledger_entries" ("account","currency")`,
    );
    await q.query(
      `CREATE INDEX "IDX_ledger_available" ON "financial_ledger_entries" ("entry_type","available_at")`,
    );

    await q.query(`
      CREATE TABLE "refunds" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
        "payment_id" uuid REFERENCES "payments"("id") ON DELETE RESTRICT,
        "channel" varchar(30) NOT NULL,
        "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
        "currency" char(3) NOT NULL,
        "status" varchar(30) NOT NULL DEFAULT 'requested',
        "reason_code" varchar(80) NOT NULL,
        "reason" text,
        "internal_note" text,
        "external_method" varchar(120),
        "external_reference" varchar(180),
        "proof_file_key" varchar(500),
        "requested_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "approved_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
        "completed_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
        "completed_at" timestamptz,
        "metadata" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX "IDX_refunds_order_status" ON "refunds" ("order_id","status")`);
    await q.query(`CREATE INDEX "IDX_refunds_status_created" ON "refunds" ("status","created_at")`);

    await q.query(`
      CREATE TABLE "teacher_settlements" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "settlement_number" varchar(40) NOT NULL UNIQUE,
        "teacher_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "gross_amount_minor" bigint NOT NULL CHECK ("gross_amount_minor" > 0),
        "deductions_minor" bigint NOT NULL DEFAULT 0 CHECK ("deductions_minor" >= 0),
        "receivable_offset_minor" bigint NOT NULL DEFAULT 0 CHECK ("receivable_offset_minor" >= 0),
        "payout_amount_minor" bigint NOT NULL CHECK ("payout_amount_minor" >= 0),
        "currency" char(3) NOT NULL,
        "status" varchar(30) NOT NULL DEFAULT 'draft',
        "payment_method" varchar(100) NOT NULL,
        "transfer_reference" varchar(180),
        "proof_file_key" varchar(500),
        "notes" text,
        "initiated_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "approved_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
        "paid_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
        "paid_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_settlement_payout" CHECK (
          "payout_amount_minor" = "gross_amount_minor" - "deductions_minor" - "receivable_offset_minor"
        )
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_teacher_settlements_teacher_status" ON "teacher_settlements" ("teacher_id","status")`,
    );
    await q.query(`
      CREATE TABLE "teacher_settlement_entries" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "settlement_id" uuid NOT NULL REFERENCES "teacher_settlements"("id") ON DELETE RESTRICT,
        "ledger_entry_id" uuid NOT NULL REFERENCES "financial_ledger_entries"("id") ON DELETE RESTRICT,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_teacher_settlement_ledger_entry" UNIQUE ("ledger_entry_id")
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_teacher_settlement_entries_settlement" ON "teacher_settlement_entries" ("settlement_id")`,
    );
    await q.query(
      `ALTER TABLE "financial_ledger_entries" ADD CONSTRAINT "FK_ledger_settlement" FOREIGN KEY ("settlement_id") REFERENCES "teacher_settlements"("id") ON DELETE RESTRICT`,
    );

    await q.query(`
      CREATE TABLE "gateway_webhook_events" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "provider" varchar(60) NOT NULL,
        "provider_event_id" varchar(180) NOT NULL,
        "payment_id" uuid REFERENCES "payments"("id") ON DELETE SET NULL,
        "status" varchar(30) NOT NULL,
        "payload" jsonb NOT NULL,
        "error_message" text,
        "processed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_gateway_webhook_provider_event" UNIQUE ("provider","provider_event_id")
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_gateway_webhook_status_created" ON "gateway_webhook_events" ("status","created_at")`,
    );

    await q.query(`
      CREATE TABLE "payment_domain_events" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "event_name" varchar(100) NOT NULL,
        "dedupe_key" varchar(180) NOT NULL UNIQUE,
        "payload" jsonb NOT NULL,
        "published_at" timestamptz,
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_payment_domain_events_pending" ON "payment_domain_events" ("published_at","created_at")`,
    );

    await q.query(`
      CREATE TABLE "payment_audit_logs" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "actor_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "action" varchar(100) NOT NULL,
        "resource_type" varchar(60) NOT NULL,
        "resource_id" uuid NOT NULL,
        "details" jsonb,
        "ip_address" varchar(45),
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_payment_audit_resource" ON "payment_audit_logs" ("resource_type","resource_id")`,
    );
    await q.query(
      `CREATE INDEX "IDX_payment_audit_actor_created" ON "payment_audit_logs" ("actor_id","created_at")`,
    );

    await q.query(`ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "dedupe_key" varchar(180)`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_notifications_dedupe_key" ON "notifications" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL`,
    );

    await q.query(`ALTER TYPE "attendance_code_status_enum" ADD VALUE IF NOT EXISTS 'generated'`);
    await q.query(`ALTER TYPE "attendance_code_status_enum" ADD VALUE IF NOT EXISTS 'assigned'`);
    await q.query(`ALTER TYPE "attendance_code_status_enum" ADD VALUE IF NOT EXISTS 'active'`);
    await q.query(`ALTER TYPE "attendance_code_status_enum" ADD VALUE IF NOT EXISTS 'reserved'`);
    await q.query(`ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "lookup_hash" char(64)`);
    await q.query(
      `ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "teacher_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "face_value_minor" bigint`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "platform_commission_bps" integer`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "currency" char(3) NOT NULL DEFAULT 'EGP'`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "valid_from" timestamptz`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "maximum_redemptions" integer NOT NULL DEFAULT 1`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "redemption_count" integer NOT NULL DEFAULT 0`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "collection_party" varchar(30) NOT NULL DEFAULT 'unknown'`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "assigned_party" varchar(120)`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "assigned_student_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT`,
    );
    await q.query(
      `ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "redeemed_order_id" uuid REFERENCES "orders"("id") ON DELETE RESTRICT`,
    );
    await q.query(`ALTER TABLE "attendance_codes" ADD COLUMN IF NOT EXISTS "metadata" jsonb`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_attendance_codes_lookup_hash" ON "attendance_codes" ("lookup_hash") WHERE "lookup_hash" IS NOT NULL`,
    );
    await q.query(
      `UPDATE "attendance_codes" SET "lookup_hash" = encode(digest(upper("code"), 'sha256'), 'hex') WHERE "lookup_hash" IS NULL`,
    );
    await q.query(`
      UPDATE "attendance_codes" c SET
        "teacher_id" = CASE c."type"::text
          WHEN 'lesson' THEN (SELECT l."teacher_id" FROM "lessons" l WHERE l."id" = c."item_id")
          WHEN 'package' THEN (SELECT lp."teacher_id" FROM "lesson_packages" lp WHERE lp."id" = c."item_id")
          WHEN 'book' THEN (SELECT b."teacher_id" FROM "books" b WHERE b."id" = c."item_id")
        END,
        "face_value_minor" = CASE c."type"::text
          WHEN 'lesson' THEN (SELECT ROUND(l."price" * 100)::bigint FROM "lessons" l WHERE l."id" = c."item_id")
          WHEN 'package' THEN (SELECT ROUND(lp."price" * 100)::bigint FROM "lesson_packages" lp WHERE lp."id" = c."item_id")
          WHEN 'book' THEN (SELECT ROUND(b."price" * 100)::bigint FROM "books" b WHERE b."id" = c."item_id")
        END,
        "redemption_count" = CASE WHEN c."is_used" THEN 1 ELSE 0 END,
        "valid_from" = COALESCE(c."valid_from", c."created_at"),
        "metadata" = COALESCE(c."metadata", '{}'::jsonb) || jsonb_build_object(
          'legacy_financial_snapshot', true,
          'collection_party_requires_review', true
        )
    `);
    await q.query(
      `ALTER TABLE "code_batches" ADD COLUMN IF NOT EXISTS "teacher_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT`,
    );
    await q.query(`ALTER TABLE "code_batches" ADD COLUMN IF NOT EXISTS "face_value_minor" bigint`);
    await q.query(
      `ALTER TABLE "code_batches" ADD COLUMN IF NOT EXISTS "platform_commission_bps" integer`,
    );
    await q.query(
      `ALTER TABLE "code_batches" ADD COLUMN IF NOT EXISTS "currency" char(3) NOT NULL DEFAULT 'EGP'`,
    );
    await q.query(
      `ALTER TABLE "code_batches" ADD COLUMN IF NOT EXISTS "collection_party" varchar(30) NOT NULL DEFAULT 'unknown'`,
    );
    await q.query(`ALTER TABLE "code_batches" ADD COLUMN IF NOT EXISTS "distribution_notes" text`);
    await q.query(
      `ALTER TABLE "code_batches" ADD COLUMN IF NOT EXISTS "export_allowed" boolean NOT NULL DEFAULT false`,
    );
    await q.query(`ALTER TABLE "code_batches" ADD COLUMN IF NOT EXISTS "metadata" jsonb`);
    await q.query(`
      UPDATE "code_batches" b SET
        "teacher_id" = CASE b."type"::text
          WHEN 'lesson' THEN (SELECT l."teacher_id" FROM "lessons" l WHERE l."id" = b."item_id")
          WHEN 'package' THEN (SELECT lp."teacher_id" FROM "lesson_packages" lp WHERE lp."id" = b."item_id")
          WHEN 'book' THEN (SELECT bk."teacher_id" FROM "books" bk WHERE bk."id" = b."item_id")
        END,
        "face_value_minor" = CASE b."type"::text
          WHEN 'lesson' THEN (SELECT ROUND(l."price" * 100)::bigint FROM "lessons" l WHERE l."id" = b."item_id")
          WHEN 'package' THEN (SELECT ROUND(lp."price" * 100)::bigint FROM "lesson_packages" lp WHERE lp."id" = b."item_id")
          WHEN 'book' THEN (SELECT ROUND(bk."price" * 100)::bigint FROM "books" bk WHERE bk."id" = b."item_id")
        END,
        "metadata" = jsonb_build_object('legacy_batch', true, 'collection_party_requires_review', true)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_orders_activation_code"`);
    await q.query(`ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "FK_orders_activation_code"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_attendance_codes_lookup_hash"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "metadata"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "redeemed_order_id"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "assigned_student_id"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "assigned_party"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "collection_party"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "redemption_count"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "maximum_redemptions"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "valid_from"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "currency"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "platform_commission_bps"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "face_value_minor"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "teacher_id"`);
    await q.query(`ALTER TABLE "attendance_codes" DROP COLUMN IF EXISTS "lookup_hash"`);
    await q.query(`ALTER TABLE "code_batches" DROP COLUMN IF EXISTS "metadata"`);
    await q.query(`ALTER TABLE "code_batches" DROP COLUMN IF EXISTS "export_allowed"`);
    await q.query(`ALTER TABLE "code_batches" DROP COLUMN IF EXISTS "distribution_notes"`);
    await q.query(`ALTER TABLE "code_batches" DROP COLUMN IF EXISTS "collection_party"`);
    await q.query(`ALTER TABLE "code_batches" DROP COLUMN IF EXISTS "currency"`);
    await q.query(`ALTER TABLE "code_batches" DROP COLUMN IF EXISTS "platform_commission_bps"`);
    await q.query(`ALTER TABLE "code_batches" DROP COLUMN IF EXISTS "face_value_minor"`);
    await q.query(`ALTER TABLE "code_batches" DROP COLUMN IF EXISTS "teacher_id"`);
    // PostgreSQL enum labels are intentionally not removed: removing enum values
    // is unsafe when another deployment may already have written them.

    await q.query(`DROP INDEX IF EXISTS "UQ_notifications_dedupe_key"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "dedupe_key"`);
    await q.query(`DROP TABLE IF EXISTS "payment_audit_logs"`);
    await q.query(`DROP TABLE IF EXISTS "payment_domain_events"`);
    await q.query(`DROP TABLE IF EXISTS "gateway_webhook_events"`);
    await q.query(
      `ALTER TABLE "financial_ledger_entries" DROP CONSTRAINT IF EXISTS "FK_ledger_settlement"`,
    );
    await q.query(`DROP TABLE IF EXISTS "teacher_settlement_entries"`);
    await q.query(`DROP TABLE IF EXISTS "teacher_settlements"`);
    await q.query(`DROP TABLE IF EXISTS "refunds"`);
    await q.query(`DROP TABLE IF EXISTS "financial_ledger_entries"`);
    await q.query(`DROP TABLE IF EXISTS "manual_payment_submissions"`);
    await q.query(`DROP TABLE IF EXISTS "manual_payment_methods"`);
    await q.query(`DROP TABLE IF EXISTS "entitlements"`);

    await q.query(`DROP INDEX IF EXISTS "IDX_book_purchases_student_book"`);
    await q.query(
      `CREATE UNIQUE INDEX "IDX_book_purchases_student_book" ON "book_purchases" ("student_id","book_id")`,
    );
    await q.query(`DROP INDEX IF EXISTS "UQ_package_purchases_payment_package_student"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_lesson_purchases_payment_lesson_student"`);
    await q.query(`ALTER TABLE "book_purchases" DROP COLUMN IF EXISTS "revocation_reason"`);
    await q.query(`ALTER TABLE "book_purchases" DROP COLUMN IF EXISTS "revoked_at"`);
    await q.query(`ALTER TABLE "package_purchases" DROP COLUMN IF EXISTS "revocation_reason"`);
    await q.query(`ALTER TABLE "package_purchases" DROP COLUMN IF EXISTS "revoked_at"`);
    await q.query(`ALTER TABLE "lesson_purchases" DROP COLUMN IF EXISTS "revocation_reason"`);
    await q.query(`ALTER TABLE "lesson_purchases" DROP COLUMN IF EXISTS "revoked_at"`);

    await q.query(`ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "FK_orders_payment"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_payments_order_id"`);
    await q.query(`ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "FK_payments_order"`);
    await q.query(
      `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "CHK_payments_amount_minor_nonnegative"`,
    );
    await q.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "completed_at"`);
    await q.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "provider_reference"`);
    await q.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "provider"`);
    await q.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "channel"`);
    await q.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "amount_minor"`);
    await q.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "order_id"`);
    await q.query(`DROP TABLE IF EXISTS "orders"`);
  }
}
