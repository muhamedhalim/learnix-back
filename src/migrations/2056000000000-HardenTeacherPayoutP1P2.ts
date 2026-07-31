import { formatFinancialPreflightReport, runFinancialPreflight } from '../payments/financial-preflight';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1/P2 payout safeguards. The read-only preflight deliberately runs before
 * every DDL statement; TypeORM runs this migration in one transaction, so a
 * violation leaves no partially applied financial restriction behind.
 */
export class HardenTeacherPayoutP1P2205600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const preflight = await runFinancialPreflight(queryRunner);
    if (!preflight.valid) throw new Error(formatFinancialPreflightReport(preflight));

    await queryRunner.query(`
      ALTER TABLE teacher_settlements
        ADD COLUMN IF NOT EXISTS fiscal_period char(7),
        ADD COLUMN IF NOT EXISTS execution_idempotency_key varchar(120),
        ADD COLUMN IF NOT EXISTS execution_fingerprint char(64)
    `);
    await queryRunner.query(`
      UPDATE teacher_settlements
      SET fiscal_period = to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM')
      WHERE fiscal_period IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE teacher_settlements
      ALTER COLUMN fiscal_period SET DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM')
    `);
    await queryRunner.query(`ALTER TABLE teacher_settlements ALTER COLUMN fiscal_period SET NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE teacher_settlements ADD CONSTRAINT CHK_teacher_settlements_fiscal_period
      CHECK (fiscal_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
    `).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('already exists')) throw error;
    });
    await queryRunner.query(`
      UPDATE teacher_settlements
      SET execution_idempotency_key = 'legacy-execution:' || id::text,
          execution_fingerprint = md5('legacy-execution:' || id::text) || md5('legacy-execution-fingerprint:' || id::text)
      WHERE status = 'paid' AND execution_idempotency_key IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS UQ_teacher_settlements_execution_idempotency_key
      ON teacher_settlements (execution_idempotency_key) WHERE execution_idempotency_key IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS UQ_teacher_settlements_active_logical_payout
      ON teacher_settlements (teacher_id, fiscal_period, currency, payout_amount_minor)
      WHERE status IN ('draft','approved','paid')
    `);

    // This is the durable allocation invariant. It serializes competing direct
    // SQL writes on the earning row, verifies currencies, and excludes terminal
    // (released) reservations without ever deleting SettlementEntry history.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enforce_teacher_settlement_allocation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE earning_amount bigint; earning_currency char(3); settlement_currency char(3); allocated bigint;
      BEGIN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        IF NEW.amount_minor IS NULL OR NEW.amount_minor <= 0 THEN
          RAISE EXCEPTION 'settlement allocation must be positive' USING ERRCODE = '23514';
        END IF;
        SELECT currency INTO settlement_currency FROM teacher_settlements WHERE id = NEW.settlement_id FOR KEY SHARE;
        IF settlement_currency IS NULL THEN
          RAISE EXCEPTION 'settlement allocation parent does not exist' USING ERRCODE = '23503';
        END IF;
        SELECT amount_minor, currency INTO earning_amount, earning_currency
        FROM financial_ledger_entries WHERE id = NEW.ledger_entry_id FOR UPDATE;
        IF earning_amount IS NULL THEN
          RAISE EXCEPTION 'settlement allocation earning does not exist' USING ERRCODE = '23503';
        END IF;
        IF earning_currency <> settlement_currency THEN
          RAISE EXCEPTION 'settlement allocation currency mismatch' USING ERRCODE = '23514';
        END IF;
        SELECT COALESCE(SUM(entry.amount_minor), 0) INTO allocated
        FROM teacher_settlement_entries entry
        JOIN teacher_settlements settlement ON settlement.id = entry.settlement_id
        WHERE entry.ledger_entry_id = NEW.ledger_entry_id
          AND settlement.status IN ('draft','approved','paid')
          AND (TG_OP = 'INSERT' OR entry.id <> NEW.id);
        IF allocated + NEW.amount_minor > earning_amount THEN
          RAISE EXCEPTION 'settlement allocation exceeds earning amount' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS TRG_enforce_teacher_settlement_allocation ON teacher_settlement_entries;
      CREATE TRIGGER TRG_enforce_teacher_settlement_allocation
      BEFORE INSERT OR UPDATE OF amount_minor, ledger_entry_id, settlement_id ON teacher_settlement_entries
      FOR EACH ROW EXECUTE FUNCTION enforce_teacher_settlement_allocation()
    `);

    // Financial children may never be removed by a teacher, order, payment, or
    // settlement delete. Convert only unsafe cascade/set-null/default actions;
    // existing restrictive FKs remain byte-for-byte unchanged.
    await queryRunner.query(`
      DO $$ DECLARE record_fk record; definition text;
      BEGIN
        FOR record_fk IN
          SELECT c.oid, c.conname, n.nspname AS schema_name, child.relname AS table_name
          FROM pg_constraint c
          JOIN pg_class child ON child.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = child.relnamespace
          JOIN pg_class parent ON parent.oid = c.confrelid
          WHERE c.contype = 'f' AND n.nspname = 'public'
            AND child.relname IN ('orders','payments','refunds','financial_ledger_entries','teacher_settlements','teacher_settlement_entries','payment_audit_logs')
            AND parent.relname IN ('users','orders','payments','refunds','financial_ledger_entries','teacher_settlements')
            AND c.confdeltype IN ('c','n','d')
        LOOP
          definition := pg_get_constraintdef(record_fk.oid, true);
          definition := regexp_replace(definition, ' ON DELETE (CASCADE|SET NULL|SET DEFAULT)', ' ON DELETE RESTRICT');
          EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', record_fk.schema_name, record_fk.table_name, record_fk.conname);
          EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', record_fk.schema_name, record_fk.table_name, record_fk.conname, definition);
        END LOOP;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS financial_maintenance_runs (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        task_name varchar(80) NOT NULL,
        worker_id varchar(120) NOT NULL,
        status varchar(20) NOT NULL,
        started_at timestamptz NOT NULL,
        finished_at timestamptz NULL,
        duration_ms bigint NOT NULL DEFAULT 0,
        processed_count integer NOT NULL DEFAULT 0,
        released_count integer NOT NULL DEFAULT 0,
        error_count integer NOT NULL DEFAULT 0,
        error_message text NULL,
        created_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS IDX_financial_maintenance_runs_task_started
      ON financial_maintenance_runs (task_name, started_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback removes newly introduced mechanics, but deliberately never
    // restores an unsafe cascade or deletes financial evidence.
    await queryRunner.query(`DROP TRIGGER IF EXISTS TRG_enforce_teacher_settlement_allocation ON teacher_settlement_entries`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS enforce_teacher_settlement_allocation()`);
    await queryRunner.query(`DROP TABLE IF EXISTS financial_maintenance_runs`);
    await queryRunner.query(`DROP INDEX IF EXISTS UQ_teacher_settlements_active_logical_payout`);
    await queryRunner.query(`DROP INDEX IF EXISTS UQ_teacher_settlements_execution_idempotency_key`);
    await queryRunner.query(`ALTER TABLE teacher_settlements DROP CONSTRAINT IF EXISTS CHK_teacher_settlements_fiscal_period`);
    await queryRunner.query(`ALTER TABLE teacher_settlements DROP COLUMN IF EXISTS execution_fingerprint`);
    await queryRunner.query(`ALTER TABLE teacher_settlements DROP COLUMN IF EXISTS execution_idempotency_key`);
    await queryRunner.query(`ALTER TABLE teacher_settlements DROP COLUMN IF EXISTS fiscal_period`);
  }
}
