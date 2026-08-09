import { AddScheduledOneToOneLessons2072000000000 } from './2072000000000-AddScheduledOneToOneLessons';

describe('AddScheduledOneToOneLessons2072000000000', () => {
  it('adds session capacity-one protection without rewriting historic purchases', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new AddScheduledOneToOneLessons2072000000000();

    await migration.up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "scheduled_lesson_sessions"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "lesson_session_bookings"');
    expect(sql).toContain('"status" IN (\'held\', \'payment_review\', \'confirmed\')');
    expect(sql).toContain('"scheduled_lesson_session_id" uuid');
    expect(sql).toContain('"legacy_individual_purchase":true');
    expect(sql).toContain('packages contain Individual lessons');
    expect(sql).toContain('unused codes target Individual lessons');
    expect(sql).not.toMatch(/(?:DELETE|TRUNCATE)\s+(?:FROM\s+)?"?(?:orders|entitlements|lesson_purchases)"?/i);
  });

  it('uses restrictive financial history relationships and a guarded rollback index', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new AddScheduledOneToOneLessons2072000000000();

    await migration.up({ query } as never);
    const upSql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(upSql).toContain('"order_id" uuid UNIQUE REFERENCES "orders"("id") ON DELETE RESTRICT');
    expect(upSql).toContain('"payment_id" uuid UNIQUE REFERENCES "payments"("id") ON DELETE RESTRICT');

    query.mockClear();
    await migration.down({ query } as never);
    const downSql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(downSql).toContain('HAVING COUNT(*) > 1');
    expect(downSql).toContain('DROP TABLE IF EXISTS "lesson_session_bookings"');
    expect(downSql.indexOf('DROP TABLE IF EXISTS "lesson_session_bookings"')).toBeLessThan(
      downSql.indexOf('DROP TABLE IF EXISTS "scheduled_lesson_sessions"'),
    );
  });
});
