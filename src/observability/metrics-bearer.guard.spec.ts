import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';

import { MetricsBearerGuard } from './metrics-bearer.guard';

function executionContext(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as ExecutionContext;
}

describe('MetricsBearerGuard', () => {
  it('fails closed when no scraper token is configured', () => {
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const guard = new MetricsBearerGuard(config as unknown as ConfigService);

    expect(() => guard.canActivate(executionContext())).toThrow(ServiceUnavailableException);
  });

  it('rejects a missing or invalid bearer token', () => {
    const config = { get: jest.fn().mockReturnValue('expected-token') };
    const guard = new MetricsBearerGuard(config as unknown as ConfigService);

    expect(() => guard.canActivate(executionContext())).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(executionContext('Bearer wrong-token'))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts the configured bearer token', () => {
    const config = { get: jest.fn().mockReturnValue('expected-token') };
    const guard = new MetricsBearerGuard(config as unknown as ConfigService);

    expect(guard.canActivate(executionContext('Bearer expected-token'))).toBe(true);
  });
});
