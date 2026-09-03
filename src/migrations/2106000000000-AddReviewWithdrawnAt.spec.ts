import { AddReviewWithdrawnAt2106000000000 } from './2106000000000-AddReviewWithdrawnAt';

describe('AddReviewWithdrawnAt migration', () => {
  it('adds a nullable withdrawn_at column to marketplace_course_reviews', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddReviewWithdrawnAt2106000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('ALTER TABLE "marketplace_course_reviews"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "withdrawn_at" timestamptz NULL');
  });

  it('down() drops only the new column', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddReviewWithdrawnAt2106000000000().down({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('DROP COLUMN IF EXISTS "withdrawn_at"');
  });
});
