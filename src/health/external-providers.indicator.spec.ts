import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import type { MailService } from '../mail/mail.service';
import type { PaymentGateway } from '../payments/providers/payment-gateway.interface';
import { ExternalProvidersHealthIndicator } from './indicators/external-providers.indicator';

describe('ExternalProvidersHealthIndicator', () => {
  const paymentGateway = (
    status = { enabled: false, configured: false, endpoint: '' },
  ): PaymentGateway =>
    ({
      name: 'configured-gateway',
      getConfigurationStatus: jest.fn().mockReturnValue(status),
    }) as unknown as PaymentGateway;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports installed but incomplete providers as misconfigured', async () => {
    const config = { get: jest.fn() } as unknown as ConfigService;
    const mail = {
      getHealthStatus: jest.fn().mockReturnValue({
        state: 'disabled',
        enabled: false,
        configured: false,
        missing: [],
        configuredTemplateCount: 0,
        probeExecuted: false,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
      }),
    } as unknown as MailService;
    const dataSource = { query: jest.fn() } as unknown as DataSource;
    const indicator = new ExternalProvidersHealthIndicator(
      config,
      mail,
      dataSource,
      paymentGateway({ enabled: true, configured: false, endpoint: '' }),
    );
    const results = await indicator.check();
    expect(results.find((result) => result.id === 'payment-gateway')).toMatchObject({
      status: 'misconfigured',
      errorCode: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
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
    const mail = {
      getHealthStatus: jest.fn().mockReturnValue({
        state: 'disabled',
        enabled: false,
        configured: false,
        missing: [],
        configuredTemplateCount: 0,
        probeExecuted: false,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
      }),
    } as unknown as MailService;
    const dataSource = { query: jest.fn() } as unknown as DataSource;
    const indicator = new ExternalProvidersHealthIndicator(
      config,
      mail,
      dataSource,
      paymentGateway(),
    );
    const results = await indicator.check();
    expect(results.find((result) => result.id === 'frontend-web')?.status).toBe('down');
    expect(results.find((result) => result.id === 'jwt-authentication')?.status).toBe('healthy');
  });

  it.each([
    ['disabled', false, false, 'disabled'],
    ['misconfigured', true, false, 'misconfigured'],
    ['configured', true, true, 'healthy'],
    ['authentication_failed', true, true, 'misconfigured'],
    ['provider_unavailable', true, true, 'degraded'],
    ['rate_limited', true, true, 'degraded'],
  ] as const)(
    'classifies MailerSend runtime state %s',
    async (state, enabled, configured, expected) => {
      const config = { get: jest.fn() } as unknown as ConfigService;
      const mail = {
        getHealthStatus: jest.fn().mockReturnValue({
          state,
          enabled,
          configured,
          missing: configured ? [] : ['MAILERSEND_API_KEY'],
          configuredTemplateCount: 4,
          probeExecuted: false,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastFailureAt: null,
        }),
      } as unknown as MailService;
      const indicator = new ExternalProvidersHealthIndicator(
        config,
        mail,
        {
          query: jest.fn(),
        } as unknown as DataSource,
        paymentGateway(),
      );
      const result = (await indicator.check()).find(
        (component) => component.id === 'mailersend-email',
      );
      expect(result?.status).toBe(expected);
      expect(JSON.stringify(result)).not.toContain('test-api-key');
    },
  );

  it('marks optional providers disabled when their capability is not configured', async () => {
    const config = {
      get: jest
        .fn()
        .mockImplementation((key: string) => (key === 'SENTRY_ENABLED' ? 'false' : undefined)),
    } as unknown as ConfigService;
    const mail = {
      getHealthStatus: jest.fn().mockReturnValue({
        state: 'disabled',
        enabled: false,
        configured: false,
        missing: [],
        configuredTemplateCount: 0,
        probeExecuted: false,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
      }),
    } as unknown as MailService;
    const results = await new ExternalProvidersHealthIndicator(
      config,
      mail,
      {
        query: jest.fn(),
      } as unknown as DataSource,
      paymentGateway(),
    ).check();
    for (const id of ['firebase', 'meta-whatsapp', 'twilio-sms', 'sentry']) {
      expect(results.find((result) => result.id === id)?.status).toBe('disabled');
    }
  });

  it('marks Sentry misconfigured only when explicitly enabled without a DSN', async () => {
    const config = {
      get: jest
        .fn()
        .mockImplementation((key: string) => (key === 'SENTRY_ENABLED' ? 'true' : undefined)),
    } as unknown as ConfigService;
    const mail = {
      getHealthStatus: jest.fn().mockReturnValue({
        state: 'disabled',
        enabled: false,
        configured: false,
        missing: [],
        configuredTemplateCount: 0,
        probeExecuted: false,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
      }),
    } as unknown as MailService;
    const results = await new ExternalProvidersHealthIndicator(
      config,
      mail,
      {
        query: jest.fn(),
      } as unknown as DataSource,
      paymentGateway(),
    ).check();
    expect(results.find((result) => result.id === 'sentry')).toMatchObject({
      status: 'misconfigured',
      required: false,
      importance: 'optional',
    });
  });
});
