import { CreateMarketplaceCommerce2095000000000 } from './2095000000000-CreateMarketplaceCommerce';

describe('CreateMarketplaceCommerce migration', () => {
  it('creates orders/enrollments/progress with the value-conservation and no-duplicate-purchase constraints', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplaceCommerce2095000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    for (const table of [
      'marketplace_orders',
      'marketplace_enrollments',
      'marketplace_lesson_progress',
    ]) {
      expect(sql).toContain(`"${table}"`);
    }
    expect(sql).toContain('UQ_mp_orders_open_per_course');
    expect(sql).toContain('CHK_mp_orders_split');
    expect(sql).toContain('CHK_mp_orders_zero_value');
    expect(sql).toContain('UQ_mp_enrollments_order');
    expect(sql).toContain('UQ_mp_enrollments_active_learner_course');
    expect(sql).toContain('UQ_mp_progress_enrollment_lesson');
    expect(sql).not.toMatch(/^\s*UPDATE\b|\bDELETE FROM\b/m);
  });

  it('down() drops progress, enrollments then orders in dependency order', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplaceCommerce2095000000000().down({ query } as never);

    const calls = query.mock.calls.map(([statement]) => String(statement));
    expect(calls[0]).toContain('DROP TABLE IF EXISTS "marketplace_lesson_progress"');
    expect(calls[1]).toContain('DROP TABLE IF EXISTS "marketplace_enrollments"');
    expect(calls[2]).toContain('DROP TABLE IF EXISTS "marketplace_orders"');
  });
});
