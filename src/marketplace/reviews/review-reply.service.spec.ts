import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { MarketplaceReviewRepliedEvent } from '../events/domain.events';
import { ReviewReplyService } from './review-reply.service';

describe('ReviewReplyService (T151)', () => {
  let reviewsRepo: { findOne: jest.Mock; save: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let service: ReviewReplyService;

  beforeEach(() => {
    reviewsRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (data: Record<string, unknown>) => data),
    };
    eventEmitter = { emit: jest.fn() };
    service = new ReviewReplyService(reviewsRepo as never, eventEmitter as never);
  });

  it('404s a nonexistent review', async () => {
    reviewsRepo.findOne.mockResolvedValue(null);
    await expect(service.reply('instructor-1', 'review-1', 'Thanks!')).rejects.toThrow(NotFoundException);
  });

  it('refuses to reply on another instructor’s course', async () => {
    reviewsRepo.findOne.mockResolvedValue({ id: 'review-1', course_id: 'course-1', course: { instructor_id: 'someone-else' } });
    await expect(service.reply('instructor-1', 'review-1', 'Thanks!')).rejects.toThrow(ForbiddenException);
  });

  it('sets the reply and emits the replied event', async () => {
    reviewsRepo.findOne.mockResolvedValue({ id: 'review-1', course_id: 'course-1', course: { instructor_id: 'instructor-1' } });
    const result = await service.reply('instructor-1', 'review-1', 'Thanks for the feedback!');
    expect(result.instructor_reply).toBe('Thanks for the feedback!');
    expect(result.instructor_reply_at).toBeInstanceOf(Date);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      MarketplaceReviewRepliedEvent.EVENT_NAME,
      expect.objectContaining({ reviewId: 'review-1', courseId: 'course-1' }),
    );
  });

  it('overwrites an existing reply rather than creating a second one (exactly one reply, editable)', async () => {
    reviewsRepo.findOne.mockResolvedValue({
      id: 'review-1',
      course_id: 'course-1',
      course: { instructor_id: 'instructor-1' },
      instructor_reply: 'Old reply',
      instructor_reply_at: new Date('2026-01-01'),
    });
    const result = await service.reply('instructor-1', 'review-1', 'New reply');
    expect(result.instructor_reply).toBe('New reply');
  });

  it('removes the reply, nulling both columns', async () => {
    reviewsRepo.findOne.mockResolvedValue({
      id: 'review-1',
      course_id: 'course-1',
      course: { instructor_id: 'instructor-1' },
      instructor_reply: 'Existing',
      instructor_reply_at: new Date(),
    });
    const result = await service.deleteReply('instructor-1', 'review-1');
    expect(result.instructor_reply).toBeNull();
    expect(result.instructor_reply_at).toBeNull();
  });
});
