import { CatalogSearchService } from './catalog-search.service';

function buildQbSpy() {
  const calls: { method: string; args: unknown[] }[] = [];
  const qb: Record<string, unknown> = {};
  for (const method of ['andWhere', 'addSelect', 'orderBy']) {
    qb[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return qb;
    };
  }
  return { qb, calls };
}

describe('CatalogSearchService', () => {
  const service = new CatalogSearchService();

  it('returns false and adds nothing for a blank or diacritics-only keyword', () => {
    const { qb, calls } = buildQbSpy();
    const used = service.applySearch(qb as never, '   ');
    expect(used).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('builds a parameterised, escaped ILIKE clause over course/category/instructor search_text', () => {
    const { qb, calls } = buildQbSpy();
    const used = service.applySearch(qb as never, 'React');
    expect(used).toBe(true);

    const where = calls.find((c) => c.method === 'andWhere');
    expect(where).toBeDefined();
    const [sql, params] = where!.args as [string, { searchLike: string }];
    expect(sql).toContain('course.title');
    expect(sql).toContain('category.name_en');
    expect(sql).toContain('instructor.display_name');
    expect(sql).toContain('lower(translate(');
    expect(sql).not.toContain('search_text');
    expect(sql).not.toContain('learnix_normalize_search_text');
    expect(sql).toContain("ESCAPE '\\'");
    expect(params.searchLike).toBe('%react%');
  });

  it('escapes LIKE metacharacters in the keyword so they are matched literally', () => {
    const { qb, calls } = buildQbSpy();
    service.applySearch(qb as never, '50%_off');
    const where = calls.find((c) => c.method === 'andWhere');
    const [, params] = where!.args as [string, { searchLike: string }];
    expect(params.searchLike).toBe('%50\\%\\_off%');
  });

  it('adds a relevance CASE ranking title above summary above description above category/instructor (FR-081)', () => {
    const { qb, calls } = buildQbSpy();
    service.applySearch(qb as never, 'react');

    const select = calls.find((c) => c.method === 'addSelect');
    expect(select).toBeDefined();
    const [caseSql, alias] = select!.args as [string, string];
    expect(alias).toBe('course_relevance');
    const titleIdx = caseSql.indexOf('course.title');
    const summaryIdx = caseSql.indexOf('course.summary');
    const descriptionIdx = caseSql.indexOf('course.description');
    expect(titleIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeLessThan(summaryIdx);
    expect(summaryIdx).toBeLessThan(descriptionIdx);
    expect(caseSql).toMatch(/THEN 4[\s\S]*THEN 3[\s\S]*THEN 2/);

    const orderBy = calls.find((c) => c.method === 'orderBy');
    expect(orderBy!.args).toEqual(['course_relevance', 'DESC']);
  });

  it('normalizes Arabic spelling variants (hamza/alef-maksura/teh-marbuta) before matching', () => {
    const { qb, calls } = buildQbSpy();
    service.applySearch(qb as never, 'برمجة'); // contains teh marbuta
    const where = calls.find((c) => c.method === 'andWhere');
    const [, params] = where!.args as [string, { searchLike: string }];
    // teh marbuta (ة) is folded to heh (ه) by normalizeArabicQuery.
    expect(params.searchLike).toContain('برمجه');
  });
});
