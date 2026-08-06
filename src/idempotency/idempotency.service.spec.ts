import { ConfigService } from '@nestjs/config';

import { IdempotencyService } from './idempotency.service';

const mockClient = {
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  isOpen: true,
  isReady: true,
  get: jest.fn().mockResolvedValue(null),
  setEx: jest.fn().mockResolvedValue('OK'),
  quit: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
};

jest.mock('redis', () => ({
  createClient: jest.fn(() => mockClient),
}));

function configFor(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('IdempotencyService key namespacing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.get.mockResolvedValue(null);
  });

  it('uses unprefixed keys on a resolved-production environment (unchanged behaviour)', async () => {
    const service = new IdempotencyService(
      configFor({ REDIS_URL: 'redis://localhost:6379', NODE_ENV: 'production' }),
    );
    await service.onModuleInit();

    await service.checkWebhook('pay-1', 'order-1');

    expect(mockClient.get).toHaveBeenCalledWith('idempotency:webhook:pay-1:order-1');
  });

  it('prefixes keys with the environment namespace on staging', async () => {
    const service = new IdempotencyService(
      configFor({
        REDIS_URL: 'redis://localhost:6379',
        NODE_ENV: 'production',
        APP_ENV: 'staging',
      }),
    );
    await service.onModuleInit();

    await service.checkWebhook('pay-1', 'order-1');
    await service.checkPaymentRequest('user-1', 'idem-1');

    expect(mockClient.get).toHaveBeenCalledWith(
      'learnix:staging:idempotency:webhook:pay-1:order-1',
    );
    expect(mockClient.get).toHaveBeenCalledWith(
      'learnix:staging:idempotency:payment:user-1:idem-1',
    );
  });

  it('stores results under the same namespaced key it reads from', async () => {
    const service = new IdempotencyService(
      configFor({ REDIS_URL: 'redis://localhost:6379', APP_ENV: 'staging' }),
    );
    await service.onModuleInit();

    await service.storeWebhookResult('pay-1', 'order-1', { ok: true });

    expect(mockClient.setEx).toHaveBeenCalledWith(
      'learnix:staging:idempotency:webhook:pay-1:order-1',
      86_400,
      JSON.stringify({ ok: true }),
    );
  });
});
