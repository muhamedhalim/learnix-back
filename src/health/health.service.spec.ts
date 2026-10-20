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
      on: jest.fn(),
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
  });

  it('reuses one Redis client across probes and closes it on shutdown', async () => {
    const service = new HealthService(
      dataSourceWithQuery(jest.fn().mockResolvedValue([])),
      configFor({ REDIS_URL: 'rediss://localhost:6379' }),
    );

    await service.getReadiness();
    await service.getReadiness();

    expect(mockRedisInstances).toHaveLength(1);
    expect(mockRedisInstances[0]?.ping).toHaveBeenCalledTimes(2);
    expect(mockRedisInstances[0]?.disconnect).not.toHaveBeenCalled();
    service.onModuleDestroy();
    expect(mockRedisInstances[0]?.disconnect).toHaveBeenCalledTimes(1);
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
        connect: jest.fn(),
        ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        disconnect: jest.fn(),
        on: jest.fn(),
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

describe('HealthService.getPublicVersion', () => {
  const service = (values: Record<string, string>) =>
    new HealthService(dataSourceWithQuery(jest.fn()), configFor(values));

  it('reports the commit the image was built from', () => {
    const sha = 'fa1455b0c0ffee0000000000000000000000beef';
    expect(service({ GIT_SHA: sha }).getPublicVersion()).toEqual({ commit: sha });
  });

  it('is null when nothing identifies the build', () => {
    expect(service({}).getPublicVersion()).toEqual({ commit: null });
  });

  it('never echoes a configured value that is not a commit id', () => {
    const result = service({ GIT_SHA: 'postgres://user:pw@db/x' }).getPublicVersion();
    expect(result).toEqual({ commit: null });
  });
});
