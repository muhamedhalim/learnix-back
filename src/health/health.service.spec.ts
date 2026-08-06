import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import { HealthService } from './health.service';

const mockRedisInstances: Array<{
  connect: jest.Mock;
  ping: jest.Mock;
  disconnect: jest.Mock;
}> = [];

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => {
    const instance = {
      connect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue('PONG'),
      disconnect: jest.fn(),
    };
    mockRedisInstances.push(instance);
    return instance;
  });
});

function dataSourceWithQuery(query: jest.Mock): DataSource {
  return { query } as unknown as DataSource;
}

function configFor(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('HealthService.getReadiness', () => {
  beforeEach(() => {
    mockRedisInstances.length = 0;
  });

  it('is ready when the database responds and Redis is not configured', async () => {
    const service = new HealthService(
      dataSourceWithQuery(jest.fn().mockResolvedValue([])),
      configFor({}),
    );

    const result = await service.getReadiness();

    expect(result.status).toBe('ready');
    expect(mockRedisInstances).toHaveLength(0);
  });

  it('is ready when both the database and a configured Redis respond', async () => {
    const service = new HealthService(
      dataSourceWithQuery(jest.fn().mockResolvedValue([])),
      configFor({ REDIS_URL: 'redis://localhost:6379' }),
    );

    const result = await service.getReadiness();

    expect(result.status).toBe('ready');
    expect(mockRedisInstances).toHaveLength(1);
    expect(mockRedisInstances[0]?.ping).toHaveBeenCalled();
    expect(mockRedisInstances[0]?.disconnect).toHaveBeenCalled();
  });

  it('is not_ready when the database query fails', async () => {
    const service = new HealthService(
      dataSourceWithQuery(jest.fn().mockRejectedValue(new Error('connection refused'))),
      configFor({}),
    );

    const result = await service.getReadiness();

    expect(result.status).toBe('not_ready');
  });

  it('is not_ready when Redis is configured but unreachable, even though the database is fine', async () => {
    (jest.requireMock('ioredis') as jest.Mock).mockImplementationOnce(() => {
      const instance = {
        connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        ping: jest.fn(),
        disconnect: jest.fn(),
      };
      mockRedisInstances.push(instance);
      return instance;
    });

    const service = new HealthService(
      dataSourceWithQuery(jest.fn().mockResolvedValue([])),
      configFor({ REDIS_URL: 'redis://localhost:6379' }),
    );

    const result = await service.getReadiness();

    expect(result.status).toBe('not_ready');
  });

  it('never leaks infrastructure details in the response', async () => {
    const service = new HealthService(
      dataSourceWithQuery(jest.fn().mockRejectedValue(new Error('secret-bearing message'))),
      configFor({}),
    );

    const result = await service.getReadiness();

    expect(JSON.stringify(result)).not.toContain('secret-bearing');
  });
});
