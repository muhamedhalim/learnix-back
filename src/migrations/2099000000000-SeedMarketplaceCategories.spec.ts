import { SeedMarketplaceCategories2099000000000 } from './2099000000000-SeedMarketplaceCategories';

describe('SeedMarketplaceCategories migration', () => {
  it('seeds exactly the eleven categories required by FR-037 with bilingual names', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new SeedMarketplaceCategories2099000000000().up({ query } as never);

    expect(query).toHaveBeenCalledTimes(11);
    const rows = query.mock.calls.map(([, params]) => params as [string, string, string, number]);
    const englishNames = rows.map(([nameEn]) => nameEn);
    expect(englishNames).toEqual(
      expect.arrayContaining([
        'Programming',
        'Web Development',
        'Mobile Development',
        'Artificial Intelligence',
        'Data Science',
        'Cybersecurity',
        'UI/UX',
        'Graphic Design',
        'Digital Marketing',
        'Business',
      ]),
    );
    // The eleventh, general category for skills outside the named ten.
    expect(englishNames).toContain('Other Professional Skills');
    // Every row carries a non-empty Arabic name — no English-only fallback here.
    for (const [, nameAr] of rows) {
      expect(nameAr.length).toBeGreaterThan(0);
    }
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('ON CONFLICT ("slug") DO NOTHING');
  });

  it('is idempotent: a second run issues the same conflict-safe inserts, never a duplicate error', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new SeedMarketplaceCategories2099000000000();

    await migration.up({ query } as never);
    await migration.up({ query } as never);

    expect(query).toHaveBeenCalledTimes(22);
  });

  it('down() removes only categories with no course assigned to them', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new SeedMarketplaceCategories2099000000000().down({ query } as never);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('marketplace_courses');
  });
});
