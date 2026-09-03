import { MarketplaceCourseCompletedEvent } from '../events/domain.events';
import { CourseCompletionNotificationListener } from './course-completion-notification.listener';

function buildListener(course: Record<string, unknown> | null = { id: 'course-1', title: 'React Basics' }) {
  const courses = { findOne: jest.fn().mockResolvedValue(course) };
  const notifications = { create: jest.fn().mockResolvedValue({}) };
  const listener = new CourseCompletionNotificationListener(courses as never, notifications as never);
  return { listener, courses, notifications };
}

describe('CourseCompletionNotificationListener (T132, FR-274)', () => {
  it('notifies the learner on course completion, in-app only', async () => {
    const { listener, notifications } = buildListener();
    await listener.handleCourseCompleted(new MarketplaceCourseCompletedEvent('enrollment-1', 'course-1', 'learner-1'));

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'learner-1', message: expect.stringContaining('React Basics') }),
      false,
    );
  });

  it('is a no-op if the course is somehow gone', async () => {
    const { listener, notifications } = buildListener(null);
    await listener.handleCourseCompleted(new MarketplaceCourseCompletedEvent('enrollment-1', 'course-1', 'learner-1'));
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('never throws even if notification delivery fails', async () => {
    const { listener, notifications } = buildListener();
    notifications.create.mockRejectedValue(new Error('boom'));
    await expect(
      listener.handleCourseCompleted(new MarketplaceCourseCompletedEvent('enrollment-1', 'course-1', 'learner-1')),
    ).resolves.toBeUndefined();
  });
});
