import type { ConfigService } from '@nestjs/config';

import { AlertCooldownStore } from './alert-cooldown.store';

const redisMock = { set: jest.fn(), del: jest.fn(), on: jest.fn(), disconnect: jest.fn() };
jest.mock('ioredis', () => jest.fn().mockImplementation(() => redisMock));

const config = (env: Record<string, string>) => ({ get: (key: string) => env[key] }) as unknown as ConfigService;

beforeEach(() => jest.clearAllMocks());

describe('AlertCooldownStore without Redis', () => {
  it('suppresses repeats of the same incident inside the window, per key', async () => {
    const store = new AlertCooldownStore(config({}));
    expect(await store.claim('db-down', 60_000)).toBe(true);
    expect(await store.claim('db-down', 60_000)).toBe(false);
    expect(await store.claim('queue-stuck', 60_000)).toBe(true);
  });

  it('a window of 0 means "every occurrence"', async () => {
    const store = new AlertCooldownStore(config({}));
    expect(await store.claim('k', 0)).toBe(true);
    expect(await store.claim('k', 0)).toBe(true);
  });

  it('a released claim can be taken again immediately', async () => {
    const store = new AlertCooldownStore(config({}));
    await store.claim('k', 60_000);
    await store.release('k');
    expect(await store.claim('k', 60_000)).toBe(true);
  });
});

describe('AlertCooldownStore with Redis (shared across replicas)', () => {
  const env = { REDIS_URL: 'rediss://cache.example:6379' };

  it('claims with one atomic SET NX PX so only one replica wins', async () => {
    redisMock.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const store = new AlertCooldownStore(config(env));
    expect(await store.claim('db-down', 900_000)).toBe(true);
    expect(await store.claim('db-down', 900_000)).toBe(false);
    expect(redisMock.set).toHaveBeenCalledWith(expect.stringContaining('alert-cooldown:db-down'), '1', 'PX', 900_000, 'NX');
  });

  it('fails open to local state when Redis errors, rather than dropping the alert', async () => {
    redisMock.set.mockRejectedValue(new Error('READONLY'));
    const store = new AlertCooldownStore(config(env));
    expect(await store.claim('k', 60_000)).toBe(true);
    expect(await store.claim('k', 60_000)).toBe(false); // still de-duplicated within this process
  });

  it('release deletes the shared key', async () => {
    const store = new AlertCooldownStore(config(env));
    await store.release('k');
    expect(redisMock.del).toHaveBeenCalledWith(expect.stringContaining('alert-cooldown:k'));
  });
});
