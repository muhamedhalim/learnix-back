import { AdminNotificationEvent } from '../../notifications/constants/admin-notification-events';
import {
  MarketplaceApplicationSubmittedEvent,
  MarketplaceCourseSubmittedEvent,
  MarketplacePayoutRequestedEvent,
  MarketplaceRefundRequestedEvent,
} from '../events/domain.events';
import { MarketplaceAdminAlertsListener } from './admin-alerts.listener';

function buildListener(course: Record<string, unknown> | null = { id: 'course-1', title: 'React Basics' }, instructor: Record<string, unknown> | null = { id: 'instructor-1', display_name: 'Ada Lovelace' }) {
  const courses = { findOne: jest.fn().mockResolvedValue(course) };
  const instructors = { findOne: jest.fn().mockResolvedValue(instructor) };
  const adminNotifications = { notifyAdmins: jest.fn().mockResolvedValue(undefined) };
  const listener = new MarketplaceAdminAlertsListener(courses as never, instructors as never, adminNotifications as never);
  return { listener, courses, instructors, adminNotifications };
}

describe('MarketplaceAdminAlertsListener (T199, FR-268)', () => {
  it('notifies admins on application submitted', async () => {
    const { listener, adminNotifications } = buildListener();
    await listener.handleApplicationSubmitted(new MarketplaceApplicationSubmittedEvent('app-1', 'user-1'));

    expect(adminNotifications.notifyAdmins).toHaveBeenCalledWith(
      AdminNotificationEvent.MARKETPLACE_APPLICATION_SUBMITTED,
      expect.objectContaining({ dedupeKey: 'app-1' }),
    );
  });

  it('notifies admins on course submitted, including the course title when found', async () => {
    const { listener, adminNotifications } = buildListener();
    await listener.handleCourseSubmitted(new MarketplaceCourseSubmittedEvent('course-1', 'instructor-1'));

    expect(adminNotifications.notifyAdmins).toHaveBeenCalledWith(
      AdminNotificationEvent.MARKETPLACE_COURSE_SUBMITTED,
      expect.objectContaining({ message: expect.stringContaining('React Basics'), dedupeKey: 'course-1' }),
    );
  });

  it('still notifies admins on course submitted even if the course lookup somehow returns nothing', async () => {
    const { listener, adminNotifications } = buildListener(null);
    await listener.handleCourseSubmitted(new MarketplaceCourseSubmittedEvent('course-1', 'instructor-1'));

    expect(adminNotifications.notifyAdmins).toHaveBeenCalledWith(
      AdminNotificationEvent.MARKETPLACE_COURSE_SUBMITTED,
      expect.objectContaining({ dedupeKey: 'course-1' }),
    );
  });

  it('notifies admins on refund requested', async () => {
    const { listener, adminNotifications } = buildListener();
    await listener.handleRefundRequested(new MarketplaceRefundRequestedEvent('refund-1', 'order-1', 'learner-1'));

    expect(adminNotifications.notifyAdmins).toHaveBeenCalledWith(
      AdminNotificationEvent.MARKETPLACE_REFUND_REQUESTED,
      expect.objectContaining({ dedupeKey: 'refund-1' }),
    );
  });

  it('notifies admins on payout requested, including the instructor name when found', async () => {
    const { listener, adminNotifications } = buildListener();
    await listener.handlePayoutRequested(new MarketplacePayoutRequestedEvent('payout-1', 'instructor-1'));

    expect(adminNotifications.notifyAdmins).toHaveBeenCalledWith(
      AdminNotificationEvent.MARKETPLACE_PAYOUT_REQUESTED,
      expect.objectContaining({ message: expect.stringContaining('Ada Lovelace'), dedupeKey: 'payout-1' }),
    );
  });

  it('never throws even if notifyAdmins itself fails', async () => {
    const { listener, adminNotifications } = buildListener();
    adminNotifications.notifyAdmins.mockRejectedValue(new Error('boom'));

    await expect(
      listener.handleApplicationSubmitted(new MarketplaceApplicationSubmittedEvent('app-1', 'user-1')),
    ).resolves.toBeUndefined();
  });
});
