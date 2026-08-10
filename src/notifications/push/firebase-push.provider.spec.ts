import { Test, type TestingModule } from '@nestjs/testing';

import { FirebaseService } from '../../firebase/firebase.service';
import { FirebasePushProvider } from './firebase-push.provider';

/**
 * The FCM adapter's only job is translating provider mechanics. What matters is
 * the error classification: getting it wrong either keeps pushing to dead
 * handsets forever, or silently unsubscribes live users on a bad provider
 * minute. Unknown codes must default to "keep the device".
 */
describe('FirebasePushProvider', () => {
  let provider: FirebasePushProvider;
  let messaging: { sendEach: jest.Mock };
  let firebase: { isConfigured: jest.Mock; getMessaging: jest.Mock };

  beforeEach(async () => {
    messaging = { sendEach: jest.fn() };
    firebase = {
      isConfigured: jest.fn(() => true),
      getMessaging: jest.fn(() => messaging),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [FirebasePushProvider, { provide: FirebaseService, useValue: firebase }],
    }).compile();

    provider = module.get(FirebasePushProvider);
  });

  const message = {
    token: 'tok',
    title: 'Title',
    body: 'Body',
    data: { notification_id: 'n1', link: '/student/notifications' },
    collapseKey: 'n1',
  };

  it('reports itself unconfigured when Firebase credentials are absent', async () => {
    firebase.isConfigured.mockReturnValue(false);
    firebase.getMessaging.mockReturnValue(null);

    expect(provider.isConfigured()).toBe(false);
    const [result] = await provider.sendEach([message]);
    expect(result).toMatchObject({ accepted: false, retryable: false });
  });

  it('sends one FCM message per token and maps acceptance', async () => {
    messaging.sendEach.mockResolvedValue({
      responses: [{ success: true, messageId: 'projects/p/messages/1' }],
    });

    const [result] = await provider.sendEach([message]);

    expect(messaging.sendEach).toHaveBeenCalledWith([
      expect.objectContaining({
        token: 'tok',
        notification: { title: 'Title', body: 'Body' },
        data: message.data,
      }),
    ]);
    expect(result).toEqual({
      token: 'tok',
      accepted: true,
      providerMessageId: 'projects/p/messages/1',
    });
  });

  it('carries the deep link through webpush fcmOptions', async () => {
    messaging.sendEach.mockResolvedValue({ responses: [{ success: true, messageId: 'x' }] });

    await provider.sendEach([message]);

    const sent = messaging.sendEach.mock.calls[0]?.[0] as Array<{
      webpush: { fcmOptions: { link?: string }; notification: { tag?: string } };
    }>;
    expect(sent[0]?.webpush.fcmOptions.link).toBe('/student/notifications');
    expect(sent[0]?.webpush.notification.tag).toBe('n1');
  });

  it.each([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument',
    'messaging/sender-id-mismatch',
  ])('treats %s as a permanently invalid token', async (code) => {
    messaging.sendEach.mockResolvedValue({
      responses: [{ success: false, error: { code, message: 'nope' } }],
    });

    const [result] = await provider.sendEach([message]);

    expect(result).toMatchObject({ accepted: false, tokenInvalid: true, retryable: false });
  });

  it.each(['messaging/internal-error', 'messaging/server-unavailable', 'messaging/quota-exceeded'])(
    'treats %s as retryable and keeps the device',
    async (code) => {
      messaging.sendEach.mockResolvedValue({
        responses: [{ success: false, error: { code, message: 'later' } }],
      });

      const [result] = await provider.sendEach([message]);

      expect(result).toMatchObject({ accepted: false, retryable: true });
      expect(result?.tokenInvalid).toBe(false);
    },
  );

  it('defaults an UNRECOGNISED error code to retryable, never to invalidation', async () => {
    messaging.sendEach.mockResolvedValue({
      responses: [{ success: false, error: { code: 'messaging/brand-new-code', message: '?' } }],
    });

    const [result] = await provider.sendEach([message]);

    expect(result?.tokenInvalid).toBe(false);
    expect(result?.retryable).toBe(true);
  });

  it('returns one result per input, in order, on a mixed batch', async () => {
    messaging.sendEach.mockResolvedValue({
      responses: [
        { success: true, messageId: 'a' },
        {
          success: false,
          error: { code: 'messaging/registration-token-not-registered', message: 'dead' },
        },
        { success: true, messageId: 'c' },
      ],
    });

    const results = await provider.sendEach([
      { ...message, token: 'a' },
      { ...message, token: 'b' },
      { ...message, token: 'c' },
    ]);

    expect(results.map((r) => r.token)).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.accepted)).toEqual([true, false, true]);
    expect(results[1]?.tokenInvalid).toBe(true);
  });

  it('never disables a device when the whole batch throws (auth/transport failure)', async () => {
    messaging.sendEach.mockRejectedValue(new Error('credential error'));

    const results = await provider.sendEach([
      { ...message, token: 'a' },
      { ...message, token: 'b' },
    ]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.accepted).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.tokenInvalid).toBeUndefined();
    }
  });

  it('short-circuits an empty batch without touching the SDK', async () => {
    await expect(provider.sendEach([])).resolves.toEqual([]);
    expect(messaging.sendEach).not.toHaveBeenCalled();
  });
});
