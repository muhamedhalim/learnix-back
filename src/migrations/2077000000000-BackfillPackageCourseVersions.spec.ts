import { BackfillPackageCourseVersions2077000000000 } from './2077000000000-BackfillPackageCourseVersions';

describe('BackfillPackageCourseVersions2077000000000', () => {
  it('reconstructs historical versions from LessonPurchase evidence, falling back to live curriculum', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new BackfillPackageCourseVersions2077000000000();

    await migration.up({ query } as never);

    const calls = query.mock.calls.map((call) => String(call[0]));
    const sql = calls.join('\n---\n');

    expect(sql).toContain('CREATE TEMP TABLE tmp_purchase_fingerprint');
    expect(sql).toContain('WHERE pp.course_version_id IS NULL');
    expect(sql).toContain("ELSE COALESCE(live.lesson_ids, ARRAY[]::uuid[])");
    expect(sql).toContain('CREATE TEMP TABLE tmp_version_groups');
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY package_id ORDER BY MIN(purchased_at) ASC)');

    // Earliest group reuses version 1 instead of duplicating it.
    expect(sql).toContain('cv.version_number = 1');
    expect(sql).toContain('cv.locked_at IS NULL');

    // Later groups get new rows, snapshotting is idempotent per version.
    expect(sql).toContain('WHERE version_number > 1');
    expect(sql).toContain('ON CONFLICT (package_id, version_number) DO NOTHING');
    expect(sql).toContain('WHERE NOT EXISTS (');
    expect(sql).toContain('SELECT 1 FROM course_version_items existing WHERE existing.version_id = cv.id');

    // A fresh unlocked "current" version is created for packages with purchases.
    expect(sql).toContain('SELECT package_id, MAX(version_number) + 1, NULL');
    expect(sql).toContain('SET current_version_id = cv.id');

    // Every purchase is finally pointed at its matching version.
    expect(sql).toContain('UPDATE package_purchases pp');
    expect(sql).toContain('SET course_version_id = cv.id');

    // Never touches historical purchase/entitlement/payment data.
    expect(sql).not.toMatch(
      /(?:DELETE|TRUNCATE)\s+(?:FROM\s+)?"?(?:lesson_purchases|package_purchases|entitlements|payments|certificates)"?/i,
    );
    expect(sql).not.toMatch(/UPDATE\s+"?lesson_purchases"?/i);
  });

  it('does not touch anything on rollback (retains reconstructed history)', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new BackfillPackageCourseVersions2077000000000();

    await migration.down({ query } as never);

    expect(query).not.toHaveBeenCalled();
  });
});
