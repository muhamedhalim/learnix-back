import { CourseReviewStatus } from '../common/enums';
import { ReviewAggregateService } from './review-aggregate.service';

function buildQb(raw: unknown) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(raw),
    getRawMany: jest.fn().mockResolvedValue(raw),
  };
}

describe('ReviewAggregateService (T150)', () => {
  let reviewsRepo: { createQueryBuilder: jest.Mock };
  let service: ReviewAggregateService;

  beforeEach(() => {
    reviewsRepo = { createQueryBuilder: jest.fn() };
    service = new ReviewAggregateService(reviewsRepo as never);
  });

  describe('getCourseAggregate', () => {
    it('returns an explicit unrated state (0/0) when no row comes back (FR-258)', async () => {
      reviewsRepo.createQueryBuilder.mockReturnValue(buildQb(undefined));
      const aggregate = await service.getCourseAggregate('course-1');
      expect(aggregate).toEqual({ averageRating: 0, reviewCount: 0, ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    });

    it('only counts approved, non-withdrawn reviews', async () => {
      const qb = buildQb({ total: '2', average: '4.5', rating_1: '0', rating_2: '0', rating_3: '0', rating_4: '1', rating_5: '1' });
      reviewsRepo.createQueryBuilder.mockReturnValue(qb);

      const aggregate = await service.getCourseAggregate('course-1');

      expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', { status: CourseReviewStatus.APPROVED });
      expect(qb.andWhere).toHaveBeenCalledWith('r.withdrawn_at IS NULL');
      expect(aggregate).toEqual({ averageRating: 4.5, reviewCount: 2, ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 } });
    });
  });

  describe('getCourseAggregatesBatch', () => {
    it('returns an empty map for an empty input without querying', async () => {
      const map = await service.getCourseAggregatesBatch([]);
      expect(map.size).toBe(0);
      expect(reviewsRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('omits a course with no approved reviews from the map entirely (never a synthetic zero row)', async () => {
      const qb = buildQb([{ course_id: 'course-1', total: '3', average: '5', rating_1: '0', rating_2: '0', rating_3: '0', rating_4: '0', rating_5: '3' }]);
      reviewsRepo.createQueryBuilder.mockReturnValue(qb);

      const map = await service.getCourseAggregatesBatch(['course-1', 'course-2']);

      expect(map.has('course-1')).toBe(true);
      expect(map.has('course-2')).toBe(false);
      expect(map.get('course-1')).toEqual({ averageRating: 5, reviewCount: 3, ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 3 } });
    });
  });
});
