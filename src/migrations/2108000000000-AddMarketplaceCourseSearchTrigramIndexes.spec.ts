import { AddMarketplaceCourseSearchTrigramIndexes2108000000000 } from './2108000000000-AddMarketplaceCourseSearchTrigramIndexes';

describe('AddMarketplaceCourseSearchTrigramIndexes migration', () => {
  it('enables pg_trgm and creates a GIN trigram index per searched column', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddMarketplaceCourseSearchTrigramIndexes2108000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(sql).toContain('"IDX_mp_courses_title_trgm"');
    expect(sql).toContain('"IDX_mp_courses_title_ar_trgm"');
    expect(sql).toContain('"IDX_mp_courses_summary_trgm"');
    expect(sql).toContain('"IDX_mp_courses_description_trgm"');
    expect(sql).toContain('USING gin ("title" gin_trgm_ops)');
  });

  it('down() drops every trigram index it created', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddMarketplaceCourseSearchTrigramIndexes2108000000000().down({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_mp_courses_title_trgm"');
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_mp_courses_title_ar_trgm"');
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_mp_courses_summary_trgm"');
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_mp_courses_description_trgm"');
  });
});
