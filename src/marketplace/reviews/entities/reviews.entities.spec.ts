import { getMetadataArgsStorage } from 'typeorm';

import { MarketplaceCourseReview } from './marketplace-course-review.entity';
import { MarketplaceReviewReport } from './marketplace-review-report.entity';

describe('MarketplaceCourseReview entity', () => {
  it('allows exactly one review per learner per course (FR-255) and bounds the rating 1-5', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceCourseReview && i.name === 'UQ_mp_reviews_learner_course',
    );
    expect(index?.unique).toBe(true);
    const check = getMetadataArgsStorage().checks.find(
      (c) => c.target === MarketplaceCourseReview && c.name === 'CHK_mp_reviews_rating',
    );
    expect(check).toBeDefined();
  });
});

describe('MarketplaceReviewReport entity', () => {
  it('allows one report per reporter per review', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceReviewReport && i.name === 'UQ_mp_review_reports_once',
    );
    expect(index?.unique).toBe(true);
  });
});
