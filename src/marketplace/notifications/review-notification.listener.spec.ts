import { MarketplaceReviewCreatedEvent } from '../events/domain.events';
import { ReviewNotificationListener } from './review-notification.listener';

function buildListener(
  course: Record<string, unknown> | null = { id: 'course-1', title: 'React Basics' },
  instructor: Record<string, unknown> | null = { id: 'instructor-1', user_id: 'instructor-user-1' },
) {
  const courses = { findOne: jest.fn().mockResolvedValue(course) };
  const instructors = { findOne: jest.fn().mockResolvedValue(instructor) };
  const notifications = { create: jest.fn().mockResolvedValue({}) };
  const listener = new ReviewNotificationListener(courses as never, instructors as never, notifications as never);
  return { listener, courses, instructors, notifications };
}

describe('ReviewNotificationListener (T159, FR-275)', () => {
  it('notifies the instructor, resolved to their user_id, on a new review', async () => {
    const { listener, notifications, instructors } = buildListener();
    await listener.handleReviewCreated(new MarketplaceReviewCreatedEvent('review-1', 'course-1', 'instructor-1'));

    expect(instructors.findOne).toHaveBeenCalledWith({ where: { id: 'instructor-1' } });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'instructor-user-1', title: 'New review', message: expect.stringContaining('React Basics') }),
      false,
    );
  });

  it('is a no-op if the course is somehow gone', async () => {
    const { listener, notifications } = buildListener(null);
    await listener.handleReviewCreated(new MarketplaceReviewCreatedEvent('review-1', 'course-1', 'instructor-1'));
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('is a no-op if the instructor record is somehow gone', async () => {
    const { listener, notifications } = buildListener(undefined, null);
    await listener.handleReviewCreated(new MarketplaceReviewCreatedEvent('review-1', 'course-1', 'instructor-1'));
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('never throws even if notification delivery fails', async () => {
    const { listener, notifications } = buildListener();
    notifications.create.mockRejectedValue(new Error('boom'));
    await expect(
      listener.handleReviewCreated(new MarketplaceReviewCreatedEvent('review-1', 'course-1', 'instructor-1')),
    ).resolves.toBeUndefined();
  });
});
