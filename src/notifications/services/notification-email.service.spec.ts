import { Test, type TestingModule } from '@nestjs/testing';

import { MailService } from '../../mail/mail.service';
import { NotificationChannel, NotificationDeliveryStatus } from '../entities';
import { NotificationChannelPolicyService } from './notification-channel-policy.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationEmailService } from './notification-email.service';

/**
 * DEF-005 — `email_enabled` must stop a real send, and must NOT be able to stop
 * a security/transactional one. The second half is asserted structurally in
 * `mail-transactional-boundary.spec.ts`; here we assert the first.
 */
describe('NotificationEmailService (DEF-005 email channel enforcement)', () => {
  let service: NotificationEmailService;
  let mail: { send: jest.Mock; isConfigured: jest.Mock };
  let policy: { decide: jest.Mock };
  let deliveries: { claim: jest.Mock; record: jest.Mock };

  beforeEach(async () => {
    mail = { send: jest.fn(async () => true), isConfigured: jest.fn(() => true) };
    policy = {
      decide: jest.fn(async () => ({ channel: NotificationChannel.EMAIL, allowed: true })),
    };
    deliveries = {
      claim: jest.fn(async () => ({ claimed: true, delivery: { id: 'del-1' } })),
      record: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationEmailService,
        { provide: MailService, useValue: mail },
        { provide: NotificationChannelPolicyService, useValue: policy },
        { provide: NotificationDeliveryService, useValue: deliveries },
      ],
    }).compile();

    service = module.get(NotificationEmailService);
  });

  const input = {
    userId: 'u1',
    notificationId: 'n1',
    to: 'student@example.com',
    subject: 'Appointment confirmed',
    text: 'Your session is confirmed.',
  };

  it('email_enabled = true runs the eligible email sender', async () => {
    await expect(service.send(input)).resolves.toBe('sent');

    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'student@example.com', subject: 'Appointment confirmed' }),
    );
    // The recipient's own identity is never leaked into the mail payload.
    expect(mail.send.mock.calls[0]?.[0]).not.toHaveProperty('userId');
    expect(mail.send.mock.calls[0]?.[0]).not.toHaveProperty('notificationId');
    expect(deliveries.record).toHaveBeenCalledWith(
      'del-1',
      NotificationDeliveryStatus.SENT,
      expect.objectContaining({ provider: 'mailersend' }),
    );
  });

  it('email_enabled = false does NOT run the email sender', async () => {
    policy.decide.mockResolvedValue({
      channel: NotificationChannel.EMAIL,
      allowed: false,
      reason: 'preference_disabled',
    });

    await expect(service.send(input)).resolves.toBe('skipped_preference');

    expect(mail.send).not.toHaveBeenCalled();
    expect(deliveries.record).toHaveBeenCalledWith(
      'del-1',
      NotificationDeliveryStatus.SKIPPED_PREFERENCE,
      expect.objectContaining({ provider: 'mailersend' }),
    );
  });

  it('changing the preference changes subsequent real dispatch behaviour', async () => {
    policy.decide.mockResolvedValue({ channel: NotificationChannel.EMAIL, allowed: false });
    await service.send(input);
    expect(mail.send).not.toHaveBeenCalled();

    policy.decide.mockResolvedValue({ channel: NotificationChannel.EMAIL, allowed: true });
    await service.send(input);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it('consults the preference before the provider, so an unconfigured provider cannot mask it', async () => {
    policy.decide.mockResolvedValue({ channel: NotificationChannel.EMAIL, allowed: false });
    mail.isConfigured.mockReturnValue(false);

    await expect(service.send(input)).resolves.toBe('skipped_preference');
  });

  it('never throws when the mail provider fails — the in-app record stands alone', async () => {
    mail.send.mockRejectedValue(new Error('MailerSend 503'));

    await expect(service.send(input)).resolves.toBe('failed');
    expect(deliveries.record).toHaveBeenCalledWith(
      'del-1',
      NotificationDeliveryStatus.FAILED,
      expect.objectContaining({ error: 'MailerSend 503' }),
    );
  });

  it('works without a notification id (no delivery leg recorded, send still gated)', async () => {
    policy.decide.mockResolvedValue({ channel: NotificationChannel.EMAIL, allowed: false });

    await expect(
      service.send({ userId: 'u1', to: 'x@example.com', subject: 's', text: 't' }),
    ).resolves.toBe('skipped_preference');

    expect(mail.send).not.toHaveBeenCalled();
    expect(deliveries.claim).not.toHaveBeenCalled();
  });
});
