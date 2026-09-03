import { BadRequestException, NotFoundException } from '@nestjs/common';

import { CourseReviewStatus } from '../common/enums';
import { MarketplaceReviewModeratedEvent } from '../events/domain.events';
import { ReviewModerationAction } from './dto/moderate-review.dto';
import { ReviewModerationService } from './review-moderation.service';

function buildQb(rows: unknown[] = [], total = 0) {
  return {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, total]),
  };
}

describe('ReviewModerationService (T152)', () => {
  let reviewsRepo: { findOne: jest.Mock; save: jest.Mock; increment: jest.Mock; createQueryBuilder: jest.Mock };
  let reportsRepo: { create: jest.Mock; save: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let service: ReviewModerationService;

  beforeEach(() => {
    reviewsRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (data: Record<string, unknown>) => data),
      increment: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
    };
    reportsRepo = { create: jest.fn((data: Record<string, unknown>) => data), save: jest.fn() };
    eventEmitter = { emit: jest.fn() };
    service = new ReviewModerationService(reviewsRepo as never, reportsRepo as never, eventEmitter as never);
  });

  describe('report', () => {
    it('404s a nonexistent review', async () => {
      reviewsRepo.findOne.mockResolvedValue(null);
      await expect(service.report('reporter-1', 'review-1', 'Spam')).rejects.toThrow(NotFoundException);
    });

    it('increments report_count without changing status (FR-260)', async () => {
      reviewsRepo.findOne.mockResolvedValue({ id: 'review-1', status: CourseReviewStatus.APPROVED });
      reportsRepo.save.mockResolvedValue({});

      await service.report('reporter-1', 'review-1', 'Spam');

      expect(reviewsRepo.increment).toHaveBeenCalledWith({ id: 'review-1' }, 'report_count', 1);
      expect(reviewsRepo.save).not.toHaveBeenCalled();
    });

    it('is a silent no-op for a duplicate report from the same reporter (UQ_mp_review_reports_once)', async () => {
      reviewsRepo.findOne.mockResolvedValue({ id: 'review-1' });
      reportsRepo.save.mockRejectedValueOnce({ code: '23505' });

      await expect(service.report('reporter-1', 'review-1', 'Spam again')).resolves.toBeUndefined();
      expect(reviewsRepo.increment).not.toHaveBeenCalled();
    });
  });

  describe('listForModeration', () => {
    it('defaults to reported-or-flagged reviews when no status filter is given', async () => {
      const qb = buildQb();
      reviewsRepo.createQueryBuilder.mockReturnValue(qb);
      await service.listForModeration();
      expect(qb.andWhere).toHaveBeenCalledWith('(r.report_count > 0 OR r.status = :flagged)', { flagged: CourseReviewStatus.FLAGGED });
    });

    it('filters to a specific status when requested', async () => {
      const qb = buildQb();
      reviewsRepo.createQueryBuilder.mockReturnValue(qb);
      await service.listForModeration(CourseReviewStatus.REJECTED);
      expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', { status: CourseReviewStatus.REJECTED });
    });
  });

  describe('moderate', () => {
    it('requires a reason to hide or remove (FR-261)', async () => {
      await expect(service.moderate('admin-1', 'review-1', { action: ReviewModerationAction.HIDE })).rejects.toThrow(BadRequestException);
      await expect(service.moderate('admin-1', 'review-1', { action: ReviewModerationAction.REMOVE, reason: '  ' })).rejects.toThrow(BadRequestException);
    });

    it('does not require a reason to approve', async () => {
      reviewsRepo.findOne.mockResolvedValue({ id: 'review-1', status: CourseReviewStatus.FLAGGED });
      const result = await service.moderate('admin-1', 'review-1', { action: ReviewModerationAction.APPROVE });
      expect(result.status).toBe(CourseReviewStatus.APPROVED);
    });

    it('maps hide -> flagged and remove -> rejected, recording the actor and reason', async () => {
      reviewsRepo.findOne.mockResolvedValue({ id: 'review-1', status: CourseReviewStatus.APPROVED });
      const hidden = await service.moderate('admin-1', 'review-1', { action: ReviewModerationAction.HIDE, reason: 'Off-topic' });
      expect(hidden).toMatchObject({ status: CourseReviewStatus.FLAGGED, moderated_by: 'admin-1', moderation_reason: 'Off-topic' });

      reviewsRepo.findOne.mockResolvedValue({ id: 'review-2', status: CourseReviewStatus.APPROVED });
      const removed = await service.moderate('admin-1', 'review-2', { action: ReviewModerationAction.REMOVE, reason: 'Abusive language' });
      expect(removed).toMatchObject({ status: CourseReviewStatus.REJECTED, moderation_reason: 'Abusive language' });
    });

    it('emits the moderated event', async () => {
      reviewsRepo.findOne.mockResolvedValue({ id: 'review-1', status: CourseReviewStatus.APPROVED });
      await service.moderate('admin-1', 'review-1', { action: ReviewModerationAction.HIDE, reason: 'x' });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        MarketplaceReviewModeratedEvent.EVENT_NAME,
        expect.objectContaining({ reviewId: 'review-1', status: CourseReviewStatus.FLAGGED }),
      );
    });
  });
});
