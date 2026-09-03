import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { CourseReviewStatus, MarketplaceEnrollmentStatus } from '../common/enums';
import { MarketplaceReviewCreatedEvent } from '../events/domain.events';
import { MarketplaceReviewService } from './review.service';

function buildQb(rows: unknown[] = [], total = 0) {
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, total]),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  return qb;
}

describe('MarketplaceReviewService (T149)', () => {
  let reviewsRepo: { create: jest.Mock; save: jest.Mock; find: jest.Mock; findOne: jest.Mock; remove: jest.Mock; createQueryBuilder: jest.Mock };
  let coursesRepo: { findOne: jest.Mock };
  let enrollmentsRepo: { findOne: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let service: MarketplaceReviewService;

  beforeEach(() => {
    reviewsRepo = {
      create: jest.fn((data: Record<string, unknown>) => data),
      save: jest.fn(async (data: Record<string, unknown>) => ({ id: 'review-1', ...data })),
      find: jest.fn(),
      findOne: jest.fn(),
      remove: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    coursesRepo = { findOne: jest.fn() };
    enrollmentsRepo = { findOne: jest.fn() };
    eventEmitter = { emit: jest.fn() };
    service = new MarketplaceReviewService(reviewsRepo as never, coursesRepo as never, enrollmentsRepo as never, eventEmitter as never);
  });

  describe('createReview', () => {
    it('refuses a learner without an active enrollment (FR-253)', async () => {
      enrollmentsRepo.findOne.mockResolvedValue(null);
      await expect(service.createReview('learner-1', { courseId: 'course-1', rating: 5 })).rejects.toThrow(ForbiddenException);
      expect(reviewsRepo.save).not.toHaveBeenCalled();
    });

    it('creates a review for an actively-enrolled learner and emits the created event', async () => {
      enrollmentsRepo.findOne.mockResolvedValue({ id: 'enrollment-1', status: MarketplaceEnrollmentStatus.ACTIVE });
      coursesRepo.findOne.mockResolvedValue({ id: 'course-1', instructor_id: 'instructor-1' });

      const review = await service.createReview('learner-1', { courseId: 'course-1', rating: 5, comment: 'Great course' });

      expect(review).toMatchObject({ course_id: 'course-1', enrollment_id: 'enrollment-1', learner_id: 'learner-1', rating: 5 });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        MarketplaceReviewCreatedEvent.EVENT_NAME,
        expect.objectContaining({ courseId: 'course-1', instructorId: 'instructor-1' }),
      );
    });

    it('translates a unique-constraint violation into REVIEW_ALREADY_EXISTS (FR-255)', async () => {
      enrollmentsRepo.findOne.mockResolvedValue({ id: 'enrollment-1', status: MarketplaceEnrollmentStatus.ACTIVE });
      coursesRepo.findOne.mockResolvedValue({ id: 'course-1', instructor_id: 'instructor-1' });
      reviewsRepo.save.mockRejectedValueOnce({ code: '23505' });

      await expect(service.createReview('learner-1', { courseId: 'course-1', rating: 4 })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'REVIEW_ALREADY_EXISTS' }),
      });
    });
  });

  describe('updateOwnReview / deleteOwnReview', () => {
    it('404s a review that does not belong to the caller (IDOR-safe)', async () => {
      reviewsRepo.findOne.mockResolvedValue(null);
      await expect(service.updateOwnReview('learner-1', 'review-1', { rating: 3 })).rejects.toThrow(NotFoundException);
    });

    it('patches only the provided fields', async () => {
      reviewsRepo.findOne.mockResolvedValue({ id: 'review-1', learner_id: 'learner-1', rating: 2, comment: 'old' });
      const updated = await service.updateOwnReview('learner-1', 'review-1', { rating: 5 });
      expect(updated).toMatchObject({ rating: 5, comment: 'old' });
    });

    it('hard-deletes the caller’s own review', async () => {
      const review = { id: 'review-1', learner_id: 'learner-1' };
      reviewsRepo.findOne.mockResolvedValue(review);
      await service.deleteOwnReview('learner-1', 'review-1');
      expect(reviewsRepo.remove).toHaveBeenCalledWith(review);
    });
  });

  describe('listPublicReviews', () => {
    it('404s a course that is not published/visible', async () => {
      coursesRepo.findOne.mockResolvedValue(null);
      await expect(service.listPublicReviews('some-slug', 1, 20)).rejects.toThrow(NotFoundException);
    });

    it('only returns approved, non-withdrawn reviews, sorted by recency by default', async () => {
      coursesRepo.findOne.mockResolvedValue({ id: 'course-1' });
      const qb = buildQb(
        [{ id: 'r1', rating: 5, comment: 'x', instructor_reply: null, instructor_reply_at: null, created_at: new Date(), learner: { id: 'l1', name: 'Ada' } }],
        1,
      );
      reviewsRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listPublicReviews('some-slug', 1, 20);

      expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', { status: CourseReviewStatus.APPROVED });
      expect(qb.andWhere).toHaveBeenCalledWith('r.withdrawn_at IS NULL');
      expect(qb.orderBy).toHaveBeenCalledWith('r.created_at', 'DESC');
      expect(result.data).toEqual([expect.objectContaining({ id: 'r1', learner: { id: 'l1', name: 'Ada' } })]);
      expect(result.meta.total).toBe(1);
    });

    it('sorts by rating when requested (FR-264)', async () => {
      coursesRepo.findOne.mockResolvedValue({ id: 'course-1' });
      const qb = buildQb([], 0);
      reviewsRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listPublicReviews('some-slug', 1, 20, 'rating');

      expect(qb.orderBy).toHaveBeenCalledWith('r.rating', 'DESC');
    });
  });

  describe('withdrawForEnrollment', () => {
    it('is a no-op if no review exists for that learner/course', async () => {
      reviewsRepo.findOne.mockResolvedValue(null);
      await service.withdrawForEnrollment('course-1', 'learner-1');
      expect(reviewsRepo.save).not.toHaveBeenCalled();
    });

    it('is idempotent — never overwrites an already-withdrawn timestamp', async () => {
      const existingWithdrawal = new Date('2026-01-01T00:00:00.000Z');
      reviewsRepo.findOne.mockResolvedValue({ id: 'review-1', withdrawn_at: existingWithdrawal });
      await service.withdrawForEnrollment('course-1', 'learner-1');
      expect(reviewsRepo.save).not.toHaveBeenCalled();
    });

    it('sets withdrawn_at on a live review', async () => {
      reviewsRepo.findOne.mockResolvedValue({ id: 'review-1', withdrawn_at: null });
      await service.withdrawForEnrollment('course-1', 'learner-1');
      expect(reviewsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ withdrawn_at: expect.any(Date) }));
    });
  });

  describe('listForInstructor', () => {
    it('scopes reviews to courses owned by the instructor', async () => {
      const qb = buildQb([{ id: 'r1' }]);
      reviewsRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.listForInstructor('instructor-1');
      expect(qb.where).toHaveBeenCalledWith('course.instructor_id = :instructorId', { instructorId: 'instructor-1' });
      expect(result).toEqual([{ id: 'r1' }]);
    });
  });
});
