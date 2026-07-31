import { UnifiedPaymentsAndEntitlements1940000000000 } from './1940000000000-UnifiedPaymentsAndEntitlements';

describe('UnifiedPaymentsAndEntitlements1940000000000', () => {
  it('backfills lesson snapshots from the canonical lessons.title column', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new UnifiedPaymentsAndEntitlements1940000000000();

    await migration.up({ query } as never);

    const orderBackfill = query.mock.calls
      .map(([statement]) => statement as string)
      .find((statement) => statement.includes('INSERT INTO "orders"'));

    expect(orderBackfill).toContain(
      `WHEN 'lesson' THEN (SELECT l."title" FROM "lessons" l WHERE l."id" = p."item_id")`,
    );
    expect(orderBackfill).not.toContain('l."title_ar"');
    expect(orderBackfill).toContain('lp."title_ar"');
    expect(orderBackfill).toContain('b."title_ar"');
  });
});
