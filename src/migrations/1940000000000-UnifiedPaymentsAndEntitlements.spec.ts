import { UnifiedPaymentsAndEntitlements1940000000000 } from './1940000000000-UnifiedPaymentsAndEntitlements';

describe('UnifiedPaymentsAndEntitlements1940000000000', () => {
  function statementIndex(statements: string[], fragment: string): number {
    const index = statements.findIndex((statement) => statement.includes(fragment));
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
  }

  it('installs orders constraints before backfilling and uses the canonical lesson title', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new UnifiedPaymentsAndEntitlements1940000000000();

    await migration.up({ query } as never);

    const statements = query.mock.calls.map(([statement]) => statement as string);
    const orderBackfillIndex = statementIndex(statements, 'INSERT INTO "orders"');
    const orderBackfill = statements[orderBackfillIndex];

    expect(orderBackfill).toContain(
      `WHEN 'lesson' THEN (SELECT l."title" FROM "lessons" l WHERE l."id" = p."item_id")`,
    );
    expect(orderBackfill).not.toContain('l."title_ar"');
    expect(orderBackfill).toContain('lp."title_ar"');
    expect(orderBackfill).toContain('b."title_ar"');

    expect(
      statementIndex(
        statements,
        'ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_activation_code"',
      ),
    ).toBeLessThan(orderBackfillIndex);
    expect(
      statementIndex(statements, 'CREATE UNIQUE INDEX "UQ_orders_activation_code"'),
    ).toBeLessThan(orderBackfillIndex);
    expect(
      statementIndex(statements, 'ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_payment"'),
    ).toBeLessThan(orderBackfillIndex);
    expect(
      statementIndex(statements, 'CREATE INDEX "IDX_orders_channel_created"'),
    ).toBeLessThan(orderBackfillIndex);
  });

  it('creates attendance code indexes before their backfill and rolls back order constraints first', async () => {
    const upQuery = jest.fn().mockResolvedValue(undefined);
    const downQuery = jest.fn().mockResolvedValue(undefined);
    const migration = new UnifiedPaymentsAndEntitlements1940000000000();

    await migration.up({ query: upQuery } as never);
    await migration.down({ query: downQuery } as never);

    const upStatements = upQuery.mock.calls.map(([statement]) => statement as string);
    expect(
      statementIndex(upStatements, 'CREATE UNIQUE INDEX "UQ_attendance_codes_lookup_hash"'),
    ).toBeLessThan(
      statementIndex(upStatements, 'UPDATE "attendance_codes" SET "lookup_hash"'),
    );

    const downStatements = downQuery.mock.calls.map(([statement]) => statement as string);
    expect(
      statementIndex(downStatements, 'ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "FK_orders_activation_code"'),
    ).toBeLessThan(statementIndex(downStatements, 'DROP TABLE IF EXISTS "orders"'));
  });
});
