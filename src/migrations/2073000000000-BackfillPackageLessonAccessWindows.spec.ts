import { BackfillPackageLessonAccessWindows2073000000000 } from './2073000000000-BackfillPackageLessonAccessWindows';

describe('BackfillPackageLessonAccessWindows2073000000000', () => {
  it('backfills only missing package lesson projections with each lesson duration', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new BackfillPackageLessonAccessWindows2073000000000();

    await migration.up({ query } as never);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('INSERT INTO "lesson_purchases"');
    expect(sql).toContain('lesson."available_for_days" * INTERVAL \'1 day\'');
    expect(sql).toContain('ON CONFLICT ("payment_id", "lesson_id", "student_id") DO NOTHING');
    expect(sql).toContain('pp."revoked_at"');
    expect(sql).not.toMatch(/(?:DELETE|TRUNCATE|UPDATE)\s+(?:FROM\s+)?"?(?:package_purchases|lesson_purchases|entitlements|attendance_codes)"?/i);
  });

  it('does not delete historic purchase projections during rollback', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new BackfillPackageLessonAccessWindows2073000000000();

    await migration.down({ query } as never);

    expect(query).not.toHaveBeenCalled();
  });
});
