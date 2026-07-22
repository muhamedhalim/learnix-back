import { areQueuesEnabled } from './queues.constants';

describe('areQueuesEnabled', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalRedisUrl = process.env['REDIS_URL'];
  const originalE2EOverride = process.env['E2E_DISABLE_BACKGROUND_WORKERS'];

  afterEach(() => {
    restoreEnvironment('NODE_ENV', originalNodeEnv);
    restoreEnvironment('REDIS_URL', originalRedisUrl);
    restoreEnvironment('E2E_DISABLE_BACKGROUND_WORKERS', originalE2EOverride);
  });

  it('keeps Redis-backed queues enabled by default', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
    delete process.env['E2E_DISABLE_BACKGROUND_WORKERS'];

    expect(areQueuesEnabled()).toBe(true);
  });

  it('allows the E2E runner to disable only background workers', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
    process.env['E2E_DISABLE_BACKGROUND_WORKERS'] = 'true';

    expect(areQueuesEnabled()).toBe(false);
  });

  it('cannot disable queues outside the test environment', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['REDIS_URL'] = 'redis://redis.internal:6379';
    process.env['E2E_DISABLE_BACKGROUND_WORKERS'] = 'true';

    expect(areQueuesEnabled()).toBe(true);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
