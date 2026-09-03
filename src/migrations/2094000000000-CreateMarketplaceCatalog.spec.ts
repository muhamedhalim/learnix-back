import { CreateMarketplaceCatalog2094000000000 } from './2094000000000-CreateMarketplaceCatalog';

describe('CreateMarketplaceCatalog migration', () => {
  it('creates the full catalogue tree with the removal and duration constraints', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplaceCatalog2094000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    for (const table of [
      'marketplace_categories',
      'marketplace_courses',
      'marketplace_course_sections',
      'marketplace_course_lessons',
      'marketplace_course_versions',
      'marketplace_course_removals',
      'marketplace_course_review_decisions',
    ]) {
      expect(sql).toContain(`"${table}"`);
    }
    expect(sql).toContain('CHK_mp_lessons_duration_positive');
    expect(sql).toContain('CHK_mp_courses_removed');
    expect(sql).toContain('UQ_mp_course_removals_course');
    expect(sql).toContain('IDX_mp_courses_public');
    expect(sql).toContain('IDX_mp_courses_instructor_status');
    expect(sql).toContain('IDX_mp_courses_review_queue');
    expect(sql).toContain('IDX_mp_courses_price');
    expect(sql).not.toMatch(/^\s*UPDATE\b|\bDELETE FROM\b/m);
  });

  it('down() drops every table this migration creates', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplaceCatalog2094000000000().down({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    for (const table of [
      'marketplace_categories',
      'marketplace_courses',
      'marketplace_course_sections',
      'marketplace_course_lessons',
      'marketplace_course_versions',
      'marketplace_course_removals',
      'marketplace_course_review_decisions',
    ]) {
      expect(sql).toContain(`DROP TABLE IF EXISTS "${table}"`);
    }
  });
});
