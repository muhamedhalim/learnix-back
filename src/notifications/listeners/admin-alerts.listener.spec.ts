import { AdminNotificationEvent } from '../constants/admin-notification-events';
import { AdminAlertsListener } from './admin-alerts.listener';

function buildListener(order: unknown = null) {
  const orders = { findOne: jest.fn().mockResolvedValue(order) };
  const adminNotifications = { notifyAdmins: jest.fn().mockResolvedValue(undefined) };
  const listener = new AdminAlertsListener(orders as never, adminNotifications as never);
  return { listener, orders, adminNotifications };
}

describe('AdminAlertsListener', () => {
  describe('payment.succeeded', () => {
    const order = {
      id: 'order-1',
      order_number: 'ORD-1',
      product_title_snapshot: 'Algebra 101',
      final_amount_minor: 5000,
      currency: 'USD',
    };

    it('notifies admins of a completed purchase', async () => {
      const { listener, adminNotifications } = buildListener(order);

      await listener.handlePaymentSucceeded({ order_id: 'order-1' });

      expect(adminNotifications.notifyAdmins).toHaveBeenCalledWith(
        AdminNotificationEvent.PURCHASE_COMPLETED,
        expect.objectContaining({
          link: '/admin/payments?tab=orders',
          dedupeKey: 'order-1',
        }),
      );
      const [, params] = adminNotifications.notifyAdmins.mock.calls[0] as [
        string,
        { message: string },
      ];
      expect(params.message).toContain('ORD-1');
      expect(params.message).toContain('Algebra 101');
    });

    it('does nothing when the order cannot be found', async () => {
      const { listener, adminNotifications } = buildListener(null);

      await listener.handlePaymentSucceeded({ order_id: 'missing' });

      expect(adminNotifications.notifyAdmins).not.toHaveBeenCalled();
    });

    it('does nothing when the payload carries no order id', async () => {
      const { listener, orders, adminNotifications } = buildListener(order);

      await listener.handlePaymentSucceeded({});

      expect(orders.findOne).not.toHaveBeenCalled();
      expect(adminNotifications.notifyAdmins).not.toHaveBeenCalled();
    });
  });

  describe('teacher.registration_pending', () => {
    it('notifies admins of the pending instructor request', async () => {
      const { listener, adminNotifications } = buildListener();

      await listener.handleTeacherRegistrationPending({
        userId: 'user-1',
        name: 'Jane Doe',
        email: 'jane@example.com',
      });

      expect(adminNotifications.notifyAdmins).toHaveBeenCalledWith(
        AdminNotificationEvent.TEACHER_REGISTRATION_PENDING,
        expect.objectContaining({
          link: '/admin/teachers?status=pending',
          dedupeKey: 'user-1',
        }),
      );
      const [, params] = adminNotifications.notifyAdmins.mock.calls[0] as [
        string,
        { message: string },
      ];
      expect(params.message).toContain('Jane Doe');
      expect(params.message).toContain('jane@example.com');
    });
  });

  describe('package.published', () => {
    it('notifies admins of a newly published course', async () => {
      const { listener, adminNotifications } = buildListener();

      await listener.handlePackagePublished({
        packageId: 'package-1',
        title: 'Algebra 101',
        teacherId: 'teacher-1',
      });

      expect(adminNotifications.notifyAdmins).toHaveBeenCalledWith(
        AdminNotificationEvent.COURSE_PUBLISHED_FOR_REVIEW,
        expect.objectContaining({
          link: '/admin/packages',
          dedupeKey: 'package-1',
        }),
      );
    });
  });
});
