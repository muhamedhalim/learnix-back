import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import type { MailService } from '../mail/mail.service';
import { ExternalProvidersHealthIndicator } from './indicators/external-providers.indicator';

describe('ExternalProvidersHealthIndicator', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports installed but incomplete providers as misconfigured', async () => {
    const config = {
      get: jest
        .fn()
        .mockImplementation((key: string) =>
          key === 'EASYKASH_API_KEY' ? 'configured-key' : undefined,
        ),
    } as unknown as ConfigService;
    const mail = { isConfigured: jest.fn().mockReturnValue(false) } as unknown as MailService;
    const dataSource = { query: jest.fn() } as unknown as DataSource;
    const indicator = new ExternalProvidersHealthIndicator(config, mail, dataSource);
    const results = await indicator.check();
    expect(results.find((result) => result.id === 'easykash')).toMatchObject({
      status: 'misconfigured',
      errorCode: 'EASYKASH_NOT_CONFIGURED',
    });
  });

  it('isolates an unavailable provider without failing other checks', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));
    const values: Record<string, string> = {
      FRONTEND_URL: 'https://frontend.example.test',
      JWT_SECRET: 'jwt',
      JWT_REFRESH_SECRET: 'refresh',
    };
    const config = {
      get: jest.fn().mockImplementation((key: string) => values[key]),
    } as unknown as ConfigService;
    const mail = { isConfigured: jest.fn().mockReturnValue(false) } as unknown as MailService;
    const dataSource = { query: jest.fn() } as unknown as DataSource;
    const indicator = new ExternalProvidersHealthIndicator(config, mail, dataSource);
    const results = await indicator.check();
    expect(results.find((result) => result.id === 'frontend-web')?.status).toBe('down');
    expect(results.find((result) => result.id === 'jwt-authentication')?.status).toBe('healthy');
  });
});
