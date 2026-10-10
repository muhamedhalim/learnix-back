import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  Notification,
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationType,
  PushPlatform,
  PushProviderName,
  type PushDevice,
} from '../entities';
import { PUSH_PROVIDER, type PushProvider } from '../push/push-provider.interface';
import { NotificationChannelPolicyService } from './notification-channel-policy.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { PushDeviceService } from './push-device.service';
import { PushDispatchService } from './push-dispatch.service';

/**
 * DEF-005 — these prove SUPPRESSION AND DELIVERY, not persistence.
 *
 * Every assertion is about whether `PushProvider.sendEach` was reached and with
 * what, because "the value was saved correctly" is exactly the standard the
 * original defect already met.
 */

const NOTIFICATION: Notification = {
  id: 'n1',
  user_id: 'u1',
  type: NotificationType.HOMEWORK,
  title: 'Homework graded',
  message: 'Your homework has been graded.',
  data: null,
} as Notification;

function device(id: string, token: string): PushDevice {
  return {
    id,
    user_id: 'u1',
    provider: PushProviderName.FCM,
    token,
    platform: PushPlatform.WEB,
    enabled: true,
  } as PushDevice;
}

describe('PushDispatchService (DEF-005 dispatch enforcement)', () => {
  let service: PushDispatchService;
  let provider: { name: string; isConfigured: jest.Mock; sendEach: jest.Mock };
  let devices: {
    findActiveForUser: jest.Mock;
    invalidate: jest.Mock;
    recordSuccess: jest.Mock;
    recordFailure: jest.Mock;
  };
  let policy: { decide: jest.Mock };
  let deliveries: { claim: jest.Mock; record: jest.Mock; recordSkip: jest.Mock };

  let claimSeq = 0;

  beforeEach(async () => {
    claimSeq = 0;
    provider = {
      name: 'fcm',
      isConfigured: jest.fn(() => true),
      sendEach: jest.fn(async (messages: Array<{ token: string }>) =>
        messages.map((m) => ({
          token: m.token,
          accepted: true,
          providerMessageId: `msg-${m.token}`,
        })),
      ),
    };
    devices = {
      findActiveForUser: jest.fn(async () => [device('d1', 't1')]),
      invalidate: jest.fn(),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };
    policy = {
      decide: jest.fn(async () => ({ channel: NotificationChannel.PUSH, allowed: true })),
    };
    deliveries = {
      claim: jest.fn(async () => {
        claimSeq += 1;
        return { claimed: true, delivery: { id: `del-${String(claimSeq)}` } };
      }),
      record: jest.fn(),
      recordSkip: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushDispatchService,
        {
          provide: getRepositoryToken(Notification),
          useValue: { findOne: jest.fn(async () => NOTIFICATION) },
        },
        { provide: PUSH_PROVIDER, useValue: provider as unknown as PushProvider },
        { provide: PushDeviceService, useValue: devices },
        { provide: NotificationChannelPolicyService, useValue: policy },
        { provide: NotificationDeliveryService, useValue: deliveries },
      ],
    }).compile();

    service = module.get(PushDispatchService);
  });

  it('push_enabled = true with a valid device invokes the provider', async () => {
    const outcome = await service.dispatch('n1');

    expect(provider.sendEach).toHaveBeenCalledTimes(1);
    expect(provider.sendEach).toHaveBeenCalledWith([
      expect.objectContaining({ token: 't1', title: 'Homework graded' }),
    ]);
    expect(outcome).toMatchObject({ accepted: 1, status: 'sent' });
    expect(deliveries.record).toHaveBeenCalledWith(
      'del-1',
      NotificationDeliveryStatus.SENT,
      expect.objectContaining({ provider: 'fcm', providerMessageId: 'msg-t1' }),
    );
  });

  it('push_enabled = false does NOT invoke the provider, even with a valid device', async () => {
    policy.decide.mockResolvedValue({
      channel: NotificationChannel.PUSH,
      allowed: false,
      reason: 'preference_disabled',
    });

    const outcome = await service.dispatch('n1');

    expect(provider.sendEach).not.toHaveBeenCalled();
    // The device list is not even consulted — the switch stops the work, not
    // just the send.
    expect(devices.findActiveForUser).not.toHaveBeenCalled();
    expect(outcome.status).toBe('skipped_preference');
    expect(deliveries.recordSkip).toHaveBeenCalledWith(
      'n1',
      NotificationChannel.PUSH,
      NotificationDeliveryStatus.SKIPPED_PREFERENCE,
      'fcm',
    );
  });

  it('push_enabled = true with no device sends nothing and records the reason', async () => {
    devices.findActiveForUser.mockResolvedValue([]);

    const outcome = await service.dispatch('n1');

    expect(provider.sendEach).not.toHaveBeenCalled();
    expect(outcome.status).toBe('no_registered_device');
    expect(deliveries.recordSkip).toHaveBeenCalledWith(
      'n1',
      NotificationChannel.PUSH,
      NotificationDeliveryStatus.NO_REGISTERED_DEVICE,
      'fcm',
    );
  });

  it('records provider_unavailable rather than failing when FCM is unconfigured', async () => {
    provider.isConfigured.mockReturnValue(false);

    const outcome = await service.dispatch('n1');

    expect(provider.sendEach).not.toHaveBeenCalled();
    expect(outcome.status).toBe('provider_unavailable');
  });

  it('dispatches to every active device of a multi-device user', async () => {
    devices.findActiveForUser.mockResolvedValue([
      device('d1', 't1'),
      device('d2', 't2'),
      device('d3', 't3'),
    ]);

    const outcome = await service.dispatch('n1');

    expect(provider.sendEach).toHaveBeenCalledTimes(1);
    expect(provider.sendEach.mock.calls[0]?.[0]).toHaveLength(3);
    expect(
      (provider.sendEach.mock.calls[0]?.[0] as Array<{ token: string }>).map((m) => m.token),
    ).toEqual(['t1', 't2', 't3']);
    expect(outcome).toMatchObject({ accepted: 3, status: 'sent' });
  });

  it('never addresses a revoked device — only active ones are queried', async () => {
    await service.dispatch('n1');
    expect(devices.findActiveForUser).toHaveBeenCalledWith('u1', 'fcm');
  });

  it('disables ONLY the invalid token and keeps the other devices delivered', async () => {
    devices.findActiveForUser.mockResolvedValue([
      device('d1', 'good-1'),
      device('d2', 'dead'),
      device('d3', 'good-2'),
    ]);
    provider.sendEach.mockResolvedValue([
      { token: 'good-1', accepted: true, providerMessageId: 'm1' },
      {
        token: 'dead',
        accepted: false,
        tokenInvalid: true,
        error: 'messaging/registration-token-not-registered',
      },
      { token: 'good-2', accepted: true, providerMessageId: 'm3' },
    ]);

    const outcome = await service.dispatch('n1');

    // Two real sends survive; exactly one device is disabled.
    expect(outcome).toMatchObject({ accepted: 2, invalidated: 1, status: 'partial' });
    expect(devices.invalidate).toHaveBeenCalledTimes(1);
    expect(devices.invalidate).toHaveBeenCalledWith(
      'd2',
      expect.stringContaining('not-registered'),
    );
    expect(devices.recordSuccess).toHaveBeenCalledWith('d1');
    expect(devices.recordSuccess).toHaveBeenCalledWith('d3');
    expect(devices.invalidate).not.toHaveBeenCalledWith('d1', expect.anything());
    expect(devices.invalidate).not.toHaveBeenCalledWith('d3', expect.anything());
  });

  it('does not permanently fail the job because one device token is invalid', async () => {
    devices.findActiveForUser.mockResolvedValue([device('d1', 'good'), device('d2', 'dead')]);
    provider.sendEach.mockResolvedValue([
      { token: 'good', accepted: true },
      { token: 'dead', accepted: false, tokenInvalid: true, error: 'unregistered' },
    ]);

    // Resolves: retrying cannot resurrect a dead token, so this is not a
    // retryable failure.
    await expect(service.dispatch('n1')).resolves.toMatchObject({ status: 'partial' });
  });

  it('keeps a device on a transient failure and asks the queue to retry', async () => {
    devices.findActiveForUser.mockResolvedValue([device('d1', 't1')]);
    provider.sendEach.mockResolvedValue([
      { token: 't1', accepted: false, retryable: true, error: 'messaging/internal-error' },
    ]);

    await expect(service.dispatch('n1')).rejects.toThrow(/transient/i);

    expect(devices.invalidate).not.toHaveBeenCalled();
    expect(devices.recordFailure).toHaveBeenCalledWith('d1', expect.stringContaining('internal'));
  });

  it('is idempotent across retries: a leg already terminal is not re-sent', async () => {
    devices.findActiveForUser.mockResolvedValue([device('d1', 't1'), device('d2', 't2')]);
    // d1 was already delivered on the previous attempt; only d2 is claimable.
    deliveries.claim.mockImplementation(async (input: { pushDeviceId?: string }) =>
      input.pushDeviceId === 'd1'
        ? { claimed: false, delivery: { id: 'del-old' } }
        : { claimed: true, delivery: { id: 'del-new' } },
    );

    await service.dispatch('n1', 2);

    const sent = provider.sendEach.mock.calls[0]?.[0] as Array<{ token: string }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.token).toBe('t2');
  });

  it('sends nothing at all when every leg is already terminal', async () => {
    deliveries.claim.mockResolvedValue({ claimed: false, delivery: { id: 'del-old' } });

    const outcome = await service.dispatch('n1', 3);

    expect(provider.sendEach).not.toHaveBeenCalled();
    expect(outcome.status).toBe('sent');
  });

  it('keeps sensitive content out of the payload and points the client at the API', async () => {
    await service.dispatch('n1');

    const message = (
      provider.sendEach.mock.calls[0]?.[0] as Array<{
        data: Record<string, string>;
        collapseKey?: string;
      }>
    )[0];

    expect(message?.data).toEqual({
      notification_id: 'n1',
      notification_type: NotificationType.HOMEWORK,
      link: '/student/notifications',
    });
    // A stable collapse key means a retry replaces rather than stacks.
    expect(message?.collapseKey).toBe('n1');
  });

  it('honours an in-app deep link but refuses an off-site one', async () => {
    const repo = { findOne: jest.fn() };
    const withData = async (data: Record<string, unknown>): Promise<Record<string, string>> => {
      repo.findOne.mockResolvedValue({ ...NOTIFICATION, data });
      const module = await Test.createTestingModule({
        providers: [
          PushDispatchService,
          { provide: getRepositoryToken(Notification), useValue: repo },
          { provide: PUSH_PROVIDER, useValue: provider as unknown as PushProvider },
          { provide: PushDeviceService, useValue: devices },
          { provide: NotificationChannelPolicyService, useValue: policy },
          { provide: NotificationDeliveryService, useValue: deliveries },
        ],
      }).compile();
      provider.sendEach.mockClear();
      await module.get(PushDispatchService).dispatch('n1');
      return (provider.sendEach.mock.calls[0]?.[0] as Array<{ data: Record<string, string> }>)[0]!
        .data;
    };

    expect(await withData({ link: '/student/exams/e1' })).toMatchObject({
      link: '/student/exams/e1',
    });
    expect(await withData({ link: 'https://evil.example/steal' })).toMatchObject({
      link: '/student/notifications',
    });
  });
});
