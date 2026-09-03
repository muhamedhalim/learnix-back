import { CreateMarketplaceReviews2098000000000 } from './2098000000000-CreateMarketplaceReviews';

describe('CreateMarketplaceReviews migration', () => {
  it('creates reviews and reports with the one-review-per-course and rating-range constraints', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplaceReviews2098000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('"marketplace_course_reviews"');
    expect(sql).toContain('"marketplace_review_reports"');
    expect(sql).toContain('UQ_mp_reviews_learner_course');
    expect(sql).toContain('CHK_mp_reviews_rating');
    expect(sql).toContain('UQ_mp_review_reports_once');
  });

  it('down() drops reports before reviews', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplaceReviews2098000000000().down({ query } as never);

    const calls = query.mock.calls.map(([statement]) => String(statement));
    expect(calls[0]).toContain('DROP TABLE IF EXISTS "marketplace_review_reports"');
    expect(calls[1]).toContain('DROP TABLE IF EXISTS "marketplace_course_reviews"');
  });
});
