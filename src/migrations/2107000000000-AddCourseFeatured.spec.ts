import { AddCourseFeatured2107000000000 } from './2107000000000-AddCourseFeatured';

describe('AddCourseFeatured migration', () => {
  it('adds a nullable featured_at column and a partial index on marketplace_courses', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddCourseFeatured2107000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('ALTER TABLE "marketplace_courses"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "featured_at" timestamptz NULL');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "IDX_mp_courses_featured"');
  });

  it('down() drops the index and the column', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddCourseFeatured2107000000000().down({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_mp_courses_featured"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "featured_at"');
  });
});
