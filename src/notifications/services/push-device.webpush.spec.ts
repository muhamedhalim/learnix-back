import { createECDH, randomBytes } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

import { PushProviderName } from '../entities';
import { PushDeviceService } from './push-device.service';

const subscription = (endpoint = 'https://fcm.googleapis.com/fcm/send/xyz') => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
};

function make() {
  const saved: Array<Record<string, unknown>> = [];
  const repo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((v: Record<string, unknown>) => v),
    save: jest.fn((v: Record<string, unknown>) => {
      saved.push(v);
      return Promise.resolve({ id: 'row-1', ...v });
    }),
    delete: jest.fn(),
  };
  return { service: new PushDeviceService(repo as never), repo, saved };
}

describe('PushDeviceService.register with Web Push', () => {
  it('stores a canonical token so key order cannot create duplicate subscriptions', async () => {
    const { service, repo } = make();
    const sub = subscription();
    const reordered = { keys: { auth: sub.keys.auth, p256dh: sub.keys.p256dh }, endpoint: sub.endpoint, expirationTime: null };

    await service.register({ userId: 'u1', token: JSON.stringify(reordered), provider: PushProviderName.WEBPUSH });

    const lookedUp = (repo.findOne.mock.calls[0]![0] as { where: { token: string } }).where.token;
    expect(lookedUp).toBe(JSON.stringify({ endpoint: sub.endpoint, keys: { auth: sub.keys.auth, p256dh: sub.keys.p256dh } }));
  });

  it('rejects a subscription whose endpoint is not a real push service (SSRF)', async () => {
    const { service, repo } = make();
    const evil = subscription('https://169.254.169.254/latest/meta-data/');
    await expect(
      service.register({ userId: 'u1', token: JSON.stringify(evil), provider: PushProviderName.WEBPUSH }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('leaves FCM tokens exactly as they are', async () => {
    const { service, repo } = make();
    await service.register({ userId: 'u1', token: 'fcm-token-1234567890abcdef' });
    expect((repo.findOne.mock.calls[0]![0] as { where: { token: string } }).where.token).toBe('fcm-token-1234567890abcdef');
  });
});
