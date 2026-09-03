import { AddCoursePendingReview2101000000000 } from './2101000000000-AddCoursePendingReview';

describe('AddCoursePendingReview migration', () => {
  it('adds an additive, nullable column — no existing column dropped or narrowed', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddCoursePendingReview2101000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "pending_review_since" timestamptz');
    expect(sql).not.toMatch(/DROP COLUMN|SET NOT NULL/);
  });

  it('creates a partial index for admin-queue waiting-time ordering', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddCoursePendingReview2101000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "IDX_mp_courses_pending_review"');
    expect(sql).toContain('WHERE "pending_review_since" IS NOT NULL');
  });

  it('down() drops the index and column', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddCoursePendingReview2101000000000().down({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_mp_courses_pending_review"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "pending_review_since"');
  });
});
