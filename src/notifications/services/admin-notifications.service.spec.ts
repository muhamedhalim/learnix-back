import { AdminNotificationEvent } from '../constants/admin-notification-events';
import { AdminNotificationCategory } from '../entities/admin-notification-category.enum';
import { NotificationOrigin } from '../entities/notification-origin.enum';
import { NotificationPriority } from '../entities/notification-priority.enum';
import { NotificationType } from '../entities/notification-type.enum';
import { AdminNotificationsService } from './admin-notifications.service';
import type { NotificationsService } from './notifications.service';

function buildHarness(admins: Array<{ id: string }> = [{ id: 'admin-1' }, { id: 'admin-2' }]) {
  const users = { find: jest.fn().mockResolvedValue(admins) };
  const notifications = { create: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminNotificationsService(
    users as never,
    notifications as unknown as NotificationsService,
  );
  return { service, users, notifications };
}

describe('AdminNotificationsService', () => {
  it('fans a notification out to every active admin', async () => {
    const { service, notifications } = buildHarness();

    await service.notifyAdmins(AdminNotificationEvent.TEACHER_REGISTRATION_PENDING, {
      title: 'New instructor registration request',
      message: 'Jane Doe requested to register as an instructor.',
      link: '/admin/teachers?status=pending',
    });

    expect(notifications.create).toHaveBeenCalledTimes(2);
    const [dto, sendSms, options] = notifications.create.mock.calls[0] as [
      Record<string, unknown>,
      boolean,
      Record<string, unknown>,
    ];
    expect(dto).toMatchObject({
      user_id: 'admin-1',
      type: NotificationType.CUSTOM,
      priority: NotificationPriority.HIGH,
      category: AdminNotificationCategory.INSTRUCTOR_APPROVAL,
      link: '/admin/teachers?status=pending',
      send_sms: false,
    });
    expect(sendSms).toBe(false);
    expect(options).toMatchObject({
      origin: NotificationOrigin.OPERATIONAL,
      sourceEvent: AdminNotificationEvent.TEACHER_REGISTRATION_PENDING,
    });
  });

  it('only queries active admins', async () => {
    const { service, users } = buildHarness();

    await service.notifyAdmins(AdminNotificationEvent.OPERATIONAL_ALERT, {
      title: 'Alert',
      message: 'Something happened',
    });

    expect(users.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: 'admin', is_active: true } }),
    );
  });

  it('lets a caller override the catalog default priority/category', async () => {
    const { service, notifications } = buildHarness([{ id: 'admin-1' }]);

    await service.notifyAdmins(AdminNotificationEvent.MANUAL_PAYMENT_REVIEW_REQUIRED, {
      title: 'Risky manual payment',
      message: 'Duplicate reference detected',
      priority: NotificationPriority.CRITICAL,
    });

    const [dto] = notifications.create.mock.calls[0] as [Record<string, unknown>];
    expect(dto).toMatchObject({
      priority: NotificationPriority.CRITICAL,
      category: AdminNotificationCategory.FINANCIAL,
    });
  });

  it('scopes the dedupe key to the event and each admin, so every admin still gets a row', async () => {
    const { service, notifications } = buildHarness([{ id: 'admin-1' }, { id: 'admin-2' }]);

    await service.notifyAdmins(AdminNotificationEvent.PAYOUT_DUE, {
      title: 'Payout due',
      message: 'Teacher X has an overdue balance',
      dedupeKey: 'teacher-1:USD:2026-09-03',
    });

    const options1 = notifications.create.mock.calls[0]?.[2] as Record<string, unknown>;
    const options2 = notifications.create.mock.calls[1]?.[2] as Record<string, unknown>;
    expect(options1.dedupeKey).toBe('payout_due:teacher-1:USD:2026-09-03:admin-1');
    expect(options2.dedupeKey).toBe('payout_due:teacher-1:USD:2026-09-03:admin-2');
  });

  it('omits the dedupe key entirely when the caller does not supply one', async () => {
    const { service, notifications } = buildHarness([{ id: 'admin-1' }]);

    await service.notifyAdmins(AdminNotificationEvent.OPERATIONAL_ALERT, {
      title: 'Alert',
      message: 'Something happened',
    });

    const options = notifications.create.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.dedupeKey).toBeUndefined();
  });

  it('folds the link into data.href alongside any extra data', async () => {
    const { service, notifications } = buildHarness([{ id: 'admin-1' }]);

    await service.notifyAdmins(AdminNotificationEvent.PURCHASE_COMPLETED, {
      title: 'New purchase',
      message: 'Order paid',
      link: '/admin/payments?tab=orders',
      data: { order_id: 'order-1' },
    });

    const [dto] = notifications.create.mock.calls[0] as [Record<string, unknown>];
    expect(dto.data).toEqual({ href: '/admin/payments?tab=orders', order_id: 'order-1' });
  });

  it('does not let one admin failing block notifying the rest', async () => {
    const { service, notifications } = buildHarness([{ id: 'admin-1' }, { id: 'admin-2' }]);
    notifications.create
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(undefined);

    await expect(
      service.notifyAdmins(AdminNotificationEvent.OPERATIONAL_ALERT, {
        title: 'Alert',
        message: 'Something happened',
      }),
    ).resolves.toBeUndefined();

    expect(notifications.create).toHaveBeenCalledTimes(2);
  });
});
