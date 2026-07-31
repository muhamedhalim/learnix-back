import type { INestApplication } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';

import { AddPaymentRecoveryState2050000000000 } from '../../src/migrations/2050000000000-AddPaymentRecoveryState';
import { AddFinancePermissions2051000000000 } from '../../src/migrations/2051000000000-AddFinancePermissions';
import { AddSettlementEntryAllocation2052000000000 } from '../../src/migrations/2052000000000-AddSettlementEntryAllocation';
import { AddPaymentOutboxLeases2053000000000 } from '../../src/migrations/2053000000000-AddPaymentOutboxLeases';
import { HardenTeacherPayoutStageOne2054000000000 } from '../../src/migrations/2054000000000-HardenTeacherPayoutStageOne';
import { createE2EApp, resetDatabase } from './fixtures';

/**
 * These tests intentionally execute against PostgreSQL. They prove the
 * database behaviours (partial uniqueness and SKIP LOCKED) used as financial
 * guarantees; mocks cannot provide that evidence.
 */
describe('payment recovery PostgreSQL guarantees', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await new AddPaymentRecoveryState2050000000000().up(runner);
      await new AddFinancePermissions2051000000000().up(runner);
      await new AddSettlementEntryAllocation2052000000000().up(runner);
      await new AddPaymentOutboxLeases2053000000000().up(runner);
      await new HardenTeacherPayoutStageOne2054000000000().up(runner);
    } finally {
      await runner.release();
    }
  });

  beforeEach(async () => resetDatabase(dataSource));

  afterAll(async () => app.close());

  it('has durable recovery columns and the active refund dispatch uniqueness index', async () => {
    const columns = (await dataSource.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'gateway_webhook_events'
    `)) as Array<{ column_name: string }>;
    expect(columns.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'lease_token',
        'lease_expires_at',
        'heartbeat_at',
        'next_retry_at',
        'attempt_count',
        'max_attempts',
      ]),
    );
    const indexes = (await dataSource.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'refund_attempts'
    `)) as Array<{ indexname: string }>;
    expect(indexes.map((row) => row.indexname)).toContain('UQ_refund_attempt_active_refund');
  });

  it('lets only one PostgreSQL worker claim a webhook row with SKIP LOCKED', async () => {
    const [event] = (await dataSource.query(
      `INSERT INTO gateway_webhook_events
       (provider, provider_event_id, status, payload)
       VALUES ('paymob', 'pg-lock-event', 'received', '{}'::jsonb)
       RETURNING id`,
    )) as Array<{ id: string }>;
    expect(event).toBeDefined();

    const first = dataSource.createQueryRunner();
    const second = dataSource.createQueryRunner();
    await first.connect();
    await second.connect();
    try {
      await first.startTransaction();
      const firstClaim = await first.query(
        `SELECT id FROM gateway_webhook_events WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [event!.id],
      );
      expect(firstClaim).toHaveLength(1);

      await second.startTransaction();
      const secondClaim = await second.query(
        `SELECT id FROM gateway_webhook_events WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [event!.id],
      );
      expect(secondClaim).toHaveLength(0);
      await second.rollbackTransaction();
      await first.rollbackTransaction();
    } finally {
      if (second.isTransactionActive) await second.rollbackTransaction();
      if (first.isTransactionActive) await first.rollbackTransaction();
      await second.release();
      await first.release();
    }
  });

  it('runs the payment recovery migration down and back up on the disposable schema', async () => {
    const migration = new AddPaymentRecoveryState2050000000000();
    const runner: QueryRunner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await migration.down(runner);
      const afterDown = (await runner.query(
        `SELECT to_regclass('public.refund_attempts') AS table_name`,
      )) as Array<{ table_name: string | null }>;
      expect(afterDown[0]?.table_name).toBeNull();
      await migration.up(runner);
      const afterUp = (await runner.query(
        `SELECT to_regclass('public.refund_attempts') AS table_name`,
      )) as Array<{ table_name: string | null }>;
      expect(afterUp[0]?.table_name).toBe('refund_attempts');
    } finally {
      await runner.release();
    }
  });

  it('runs the Phase 2/3 additive migrations down and back up on PostgreSQL', async () => {
    const migrations = [
      new AddFinancePermissions2051000000000(),
      new AddSettlementEntryAllocation2052000000000(),
      new AddPaymentOutboxLeases2053000000000(),
      new HardenTeacherPayoutStageOne2054000000000(),
    ];
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      for (const migration of migrations) await migration.up(runner);
      const upColumns = (await runner.query(`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'users' AND column_name = 'finance_permissions')
           OR (table_name = 'teacher_settlement_entries' AND column_name = 'amount_minor')
           OR (table_name = 'payment_domain_events' AND column_name = 'lease_token')
           OR (table_name = 'teacher_settlements' AND column_name = 'idempotency_key')
      `)) as Array<{ table_name: string; column_name: string }>;
      expect(upColumns).toHaveLength(4);
      for (const migration of [...migrations].reverse()) await migration.down(runner);
      for (const migration of migrations) await migration.up(runner);
      const afterUp = (await runner.query(
        `SELECT to_regclass('public.payment_domain_events') AS table_name`,
      )) as Array<{ table_name: string | null }>;
      expect(afterUp[0]?.table_name).toBe('payment_domain_events');
    } finally {
      await runner.release();
    }
  });

  it('enforces stage-one payout uniqueness and restricts financial user foreign keys', async () => {
    const indexes = (await dataSource.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'teacher_settlements'
    `)) as Array<{ indexname: string }>;
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'UQ_teacher_settlements_idempotency_key',
        'UQ_teacher_settlements_paid_reference_normalized',
      ]),
    );
    const fks = (await dataSource.query(`
      SELECT c.conrelid::regclass::text AS table_name, c.confdeltype
      FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.confrelid = 'users'::regclass
        AND c.conrelid IN (
          'orders'::regclass,
          'payments'::regclass,
          'financial_ledger_entries'::regclass,
          'teacher_settlements'::regclass
        )
    `)) as Array<{ table_name: string; confdeltype: string }>;
    expect(fks).not.toHaveLength(0);
    expect(fks.every((fk) => fk.confdeltype === 'r')).toBe(true);
  });
});
