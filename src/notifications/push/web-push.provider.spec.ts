import { createECDH, randomBytes } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import webpush from 'web-push';

import {
  describeWebPushToken,
  isAllowedPushEndpoint,
  parseWebPushToken,
} from './web-push.util';
import { WebPushProvider } from './web-push.provider';

/** A real browser-shaped subscription: P-256 public key + 16-byte auth secret, base64url. */
function realSubscription(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

const vapid = webpush.generateVAPIDKeys();
const config = (env: Record<string, string>) => ({ get: (key: string) => env[key] }) as unknown as ConfigService;
const CONFIGURED = {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:ops@learnix.school',
};

describe('isAllowedPushEndpoint (SSRF guard)', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('accepts the real push service %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc', // not https
    'https://169.254.169.254/latest/meta-data/', // cloud metadata
    'https://localhost/x',
    'https://10.0.0.5/x',
    'https://evil.example.com/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.example.com/x', // suffix trick
    'https://user:pass@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://[::1]/x',
    'not a url',
  ])('rejects %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});

describe('parseWebPushToken', () => {
  it('accepts a real subscription and rejects malformed ones', () => {
    const sub = realSubscription();
    expect(parseWebPushToken(JSON.stringify(sub))).toEqual(sub);
    expect(parseWebPushToken('not json')).toBeNull();
    expect(parseWebPushToken(JSON.stringify({ endpoint: sub.endpoint }))).toBeNull();
    expect(parseWebPushToken(JSON.stringify({ ...sub, keys: { p256dh: 'x', auth: 'y' } }))).toBeNull();
    expect(parseWebPushToken(JSON.stringify({ ...sub, endpoint: 'https://169.254.169.254/' }))).toBeNull();
  });

  it('describes a token by host only, never by endpoint path', () => {
    const label = describeWebPushToken(JSON.stringify(realSubscription()));
    expect(label).toBe('fcm.googleapis.com');
    expect(label).not.toContain('abc123');
  });
});

describe('WebPushProvider', () => {
  it('is unconfigured without a complete VAPID triple', async () => {
    const provider = new WebPushProvider(config({ VAPID_PUBLIC_KEY: vapid.publicKey }));
    expect(provider.isConfigured()).toBe(false);
    const [result] = await provider.sendEach([{ token: 't', title: 'a', body: 'b', data: {} }]);
    expect(result).toMatchObject({ accepted: false, retryable: false });
  });

  it('exposes only the public key', () => {
    const provider = new WebPushProvider(config(CONFIGURED));
    expect(provider.publicKey).toBe(vapid.publicKey);
    expect(JSON.stringify(provider)).not.toContain(vapid.privateKey);
  });

  it('produces a valid encrypted, VAPID-signed request for a real subscription', () => {
    // Exercises the actual web-push crypto (ECDH + aes128gcm + VAPID JWT) with our payload shape.
    const sub = realSubscription();
    const provider = new WebPushProvider(config(CONFIGURED));
    const payload = (provider as unknown as { payload: (m: unknown) => string }).payload({
      token: JSON.stringify(sub),
      title: 'New homework',
      body: 'Chapter 3',
      data: { notification_id: 'n-1', link: '/student/notifications' },
      collapseKey: 'n-1',
    });
    const details = webpush.generateRequestDetails(sub, payload, {
      vapidDetails: { subject: CONFIGURED.VAPID_SUBJECT, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: 60,
    });
    expect(details.endpoint).toBe(sub.endpoint);
    expect(details.headers['Authorization']).toMatch(/^vapid t=/);
    expect(details.headers['Content-Encoding']).toBe('aes128gcm');
    expect(Buffer.isBuffer(details.body)).toBe(true);
    expect((details.body as Buffer).length).toBeGreaterThan(payload.length); // encrypted + header
  });

  describe('sending', () => {
    let send: jest.SpyInstance;
    beforeEach(() => {
      send = jest.spyOn(webpush, 'sendNotification');
    });
    afterEach(() => send.mockRestore());

    const message = (sub: unknown) => ({
      token: JSON.stringify(sub),
      title: 'T',
      body: 'B',
      data: { notification_id: 'n1' },
      collapseKey: 'n1',
    });

    it('accepts on a 201 from the push service', async () => {
      send.mockResolvedValue({ statusCode: 201, headers: {}, body: '' });
      const provider = new WebPushProvider(config(CONFIGURED));
      const [result] = await provider.sendEach([message(realSubscription())]);
      expect(result).toMatchObject({ accepted: true });
      expect(send.mock.calls[0]![2]).toMatchObject({ TTL: expect.any(Number), topic: 'n1' });
    });

    it.each([404, 410])('treats %s as a dead subscription (disable that device only)', async (statusCode) => {
      send.mockRejectedValue(Object.assign(new Error('gone'), { statusCode }));
      const [result] = await new WebPushProvider(config(CONFIGURED)).sendEach([message(realSubscription())]);
      expect(result).toMatchObject({ accepted: false, tokenInvalid: true });
    });

    it.each([429, 500, 503, undefined])('keeps the device and retries on %s', async (statusCode) => {
      send.mockRejectedValue(Object.assign(new Error('busy'), { statusCode }));
      const [result] = await new WebPushProvider(config(CONFIGURED)).sendEach([message(realSubscription())]);
      expect(result).toMatchObject({ accepted: false, retryable: true });
      expect(result!.tokenInvalid).toBeUndefined();
    });

    it.each([400, 401, 403])('does not retry or disable on %s (our request was rejected)', async (statusCode) => {
      send.mockRejectedValue(Object.assign(new Error('bad vapid'), { statusCode }));
      const [result] = await new WebPushProvider(config(CONFIGURED)).sendEach([message(realSubscription())]);
      expect(result).toMatchObject({ accepted: false, retryable: false });
      expect(result!.tokenInvalid).toBeUndefined();
    });

    it('never contacts a non-allowlisted endpoint, and retires that device', async () => {
      const evil = { ...realSubscription(), endpoint: 'https://169.254.169.254/latest/meta-data/' };
      const [result] = await new WebPushProvider(config(CONFIGURED)).sendEach([message(evil)]);
      expect(send).not.toHaveBeenCalled();
      expect(result).toMatchObject({ accepted: false, tokenInvalid: true });
    });

    it('one failure does not suppress the others', async () => {
      send
        .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
        .mockResolvedValueOnce({ statusCode: 201, headers: {}, body: '' });
      const results = await new WebPushProvider(config(CONFIGURED)).sendEach([
        message(realSubscription()),
        message(realSubscription()),
      ]);
      expect(results.map((r) => r.accepted)).toEqual([false, true]);
    });
  });
});
