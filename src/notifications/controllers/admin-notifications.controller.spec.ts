import { BadRequestException } from '@nestjs/common';

import { AdminNotificationsController } from './admin-notifications.controller';
import { NotificationChannel, NotificationDeliveryStatus } from '../entities';

describe('AdminNotificationsController', () => {
  const bulk = {
    sendBulkNotifications: jest.fn(),
    listNotificationCampaigns: jest.fn(),
    getNotificationCampaign: jest.fn(),
  };
  const deliveries = { findOne: jest.fn(), record: jest.fn().mockResolvedValue(undefined) };
  const pushJobs = { enqueueDelivery: jest.fn().mockResolvedValue(undefined) };
  const mail = { send: jest.fn(), providerName: 'ses' };
  const stats = { getStatistics: jest.fn() };
  const controller = new AdminNotificationsController(
    {} as never,
    bulk as never,
    deliveries as never,
    pushJobs as never,
    mail as never,
    stats as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('wraps the statistics service result in the existing { message, data } envelope', async () => {
    stats.getStatistics.mockResolvedValue({ total_notifications: 3 });

    await expect(controller.getStatistics()).resolves.toEqual({
      message: 'Notification statistics retrieved',
      data: { total_notifications: 3 },
    });
  });

  it('requires an idempotency key before accepting a manual broadcast', async () => {
    await expect(
      controller.sendManualNotification(
        { userId: 'admin-1' } as never,
        {
          audience: 'all_active_students' as never,
          title: 'Update',
          message: 'Maintenance complete',
        },
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(bulk.sendBulkNotifications).not.toHaveBeenCalled();
  });

  it('returns the durable campaign identity rather than claiming delivery', async () => {
    bulk.sendBulkNotifications.mockResolvedValue({
      campaign_id: 'campaign-1',
      total_queued: 25,
      status: 'queued',
    });

    const result = await controller.sendManualNotification(
      { userId: 'admin-1' } as never,
      {
        audience: 'all_active_students' as never,
        title: 'Update',
        message: 'Maintenance complete',
      },
      'request-1',
    );

    expect(result.data).toEqual({
      campaign_id: 'campaign-1',
      intended_count: 25,
      status: 'queued',
    });
  });

  it('retries a failed push leg with a fresh queue job', async () => {
    deliveries.findOne.mockResolvedValue({
      id: 'delivery-1',
      notification_id: 'notification-1',
      channel: NotificationChannel.PUSH,
      status: NotificationDeliveryStatus.FAILED,
    });

    await controller.retryDelivery('delivery-1');

    expect(pushJobs.enqueueDelivery).toHaveBeenCalledWith('notification-1', {
      forceNewJob: true,
      retryDeliveryId: 'delivery-1',
    });
  });

  it('replays only the allow-listed email payload fields and resets the leg to queued', async () => {
    deliveries.findOne.mockResolvedValue({
      id: 'delivery-2',
      notification_id: 'notification-2',
      channel: NotificationChannel.EMAIL,
      status: NotificationDeliveryStatus.PROVIDER_UNAVAILABLE,
      request_payload: {
        to: 'student@example.test',
        subject: 'Reminder',
        text: 'Your lesson starts soon.',
        notificationDeliveryId: 'attacker-controlled',
      },
    });
    mail.send.mockResolvedValue(true);

    await controller.retryDelivery('delivery-2');

    expect(mail.send).toHaveBeenCalledWith({
      to: 'student@example.test',
      subject: 'Reminder',
      text: 'Your lesson starts soon.',
      notificationDeliveryId: 'delivery-2',
    });
    expect(deliveries.record).toHaveBeenCalledWith(
      'delivery-2',
      NotificationDeliveryStatus.QUEUED,
      { provider: 'ses' },
    );
  });

  it('refuses to replay a template-only email payload that has no rendered content', async () => {
    deliveries.findOne.mockResolvedValue({
      id: 'delivery-3',
      notification_id: 'notification-3',
      channel: NotificationChannel.EMAIL,
      status: NotificationDeliveryStatus.FAILED,
      request_payload: { to: 'student@example.test', templateId: 'legacy-template' },
    });

    await expect(controller.retryDelivery('delivery-3')).rejects.toThrow(BadRequestException);
    expect(mail.send).not.toHaveBeenCalled();
  });
});
