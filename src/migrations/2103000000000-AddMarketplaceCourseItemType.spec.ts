import { AddMarketplaceCourseItemType2103000000000 } from './2103000000000-AddMarketplaceCourseItemType';

describe('AddMarketplaceCourseItemType migration', () => {
  it('adds one new enum value, idempotently, without touching any existing value', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddMarketplaceCourseItemType2103000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain(`ALTER TYPE "payments_item_type_enum" ADD VALUE IF NOT EXISTS 'marketplace_course'`);
    expect(sql).not.toMatch(/DROP TYPE|DROP VALUE|RENAME/);
  });

  it('runs outside a transaction (ALTER TYPE ADD VALUE requirement)', () => {
    expect(new AddMarketplaceCourseItemType2103000000000().transaction).toBe(false);
  });

  it('down() is a deliberate no-op — Postgres cannot drop a single enum value', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddMarketplaceCourseItemType2103000000000().down();
    expect(query).not.toHaveBeenCalled();
  });
});
