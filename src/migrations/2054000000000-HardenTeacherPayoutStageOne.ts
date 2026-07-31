import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage-one payout hardening.  This migration is intentionally additive and
 * does not rewrite published ledger rows or historical order commissions.
 */
export class HardenTeacherPayoutStageOne2054000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "teacher_settlements"
        ADD COLUMN IF NOT EXISTS "idempotency_key" varchar(120),
        ADD COLUMN IF NOT EXISTS "idempotency_fingerprint" char(64)
    `);
    await queryRunner.query(`
      UPDATE "teacher_settlements"
      SET
        "idempotency_key" = COALESCE("idempotency_key", 'legacy:' || "id"::text),
        "idempotency_fingerprint" = COALESCE(
          "idempotency_fingerprint",
          -- Keep the backfill independent of optional pgcrypto. New requests
          -- use SHA-256 in the application; legacy rows only need a stable,
          -- non-null fingerprint because their generated key is unique.
          md5('legacy:' || "id"::text) || md5('legacy-fingerprint:' || "id"::text)
        )
      WHERE "idempotency_key" IS NULL OR "idempotency_fingerprint" IS NULL
    `);
    await queryRunner.query(
      `ALTER TABLE "teacher_settlements" ALTER COLUMN "idempotency_key" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "teacher_settlements" ALTER COLUMN "idempotency_fingerprint" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_teacher_settlements_idempotency_key" ON "teacher_settlements" ("idempotency_key")`,
    );
    // Case/whitespace variants are the same external transfer reference.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_teacher_settlements_paid_reference_normalized"
      ON "teacher_settlements" (lower(btrim("transfer_reference")))
      WHERE "status" = 'paid' AND "transfer_reference" IS NOT NULL
    `);
    await queryRunner
      .query(
        `
      ALTER TABLE "teacher_settlement_entries"
        ADD CONSTRAINT "CHK_teacher_settlement_entries_amount_positive"
        CHECK ("amount_minor" > 0) NOT VALID
    `,
      )
      .catch(async (error: unknown) => {
        // PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS.  Preserve repeatable
        // deployments while surfacing every error other than an existing name.
        if (!(error instanceof Error) || !error.message.includes('already exists')) throw error;
      });
    await queryRunner
      .query(
        `ALTER TABLE "teacher_settlement_entries" VALIDATE CONSTRAINT "CHK_teacher_settlement_entries_amount_positive"`,
      )
      .catch(async (error: unknown) => {
        if (!(error instanceof Error) || !error.message.includes('does not exist')) throw error;
      });

    // Account deletion must never cascade into financial records. Replace any
    // historical FK on these user references with explicit RESTRICT semantics.
    for (const [tableName, columnName, constraintName] of [
      ['orders', 'student_id', 'FK_orders_student_financial_restrict'],
      ['orders', 'teacher_id', 'FK_orders_teacher_financial_restrict'],
      ['payments', 'user_id', 'FK_payments_user_financial_restrict'],
      ['financial_ledger_entries', 'teacher_id', 'FK_ledger_teacher_financial_restrict'],
      ['teacher_settlements', 'teacher_id', 'FK_settlements_teacher_financial_restrict'],
    ] as const) {
      await queryRunner.query(`
        DO $$
        DECLARE constraint_record record;
        BEGIN
          FOR constraint_record IN
            SELECT constraint_name
            FROM information_schema.key_column_usage
            WHERE table_schema = 'public'
              AND table_name = '${tableName}'
              AND column_name = '${columnName}'
          LOOP
            IF EXISTS (
              SELECT 1
              FROM pg_constraint c
              WHERE c.conname = constraint_record.constraint_name
                AND c.contype = 'f'
                AND c.confrelid = 'users'::regclass
            ) THEN
              EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', '${tableName}', constraint_record.constraint_name);
            END IF;
          END LOOP;
        END $$;
      `);
      const nullable = tableName === 'orders' && columnName === 'teacher_id';
      await queryRunner.query(
        `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("${columnName}") REFERENCES "users"("id") ON DELETE RESTRICT${nullable ? '' : ''}`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Do not restore unsafe cascade behaviour in a rollback.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_teacher_settlements_paid_reference_normalized"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_teacher_settlements_idempotency_key"`);
    await queryRunner.query(
      `ALTER TABLE "teacher_settlement_entries" DROP CONSTRAINT IF EXISTS "CHK_teacher_settlement_entries_amount_positive"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teacher_settlements" DROP COLUMN IF EXISTS "idempotency_fingerprint"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teacher_settlements" DROP COLUMN IF EXISTS "idempotency_key"`,
    );
  }
}
