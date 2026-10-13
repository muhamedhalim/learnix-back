const initMock = jest.fn();
const captureExceptionMock = jest.fn();

jest.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => initMock(...args),
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  withScope: (callback: (scope: unknown) => void) => {
    callback({
      setTag: jest.fn(),
      setContext: jest.fn(),
      setUser: jest.fn(),
      setLevel: jest.fn(),
    });
  },
}));

import {
  captureHandledException,
  initSentry,
  isSentryConfigured,
  isSentryEnabled,
  registerGlobalErrorHandlers,
  resetSentryStateForTesting,
  scrubSentryEvent,
} from './sentry';

const MONITORED_KEYS = [
  'SENTRY_DSN',
  'SENTRY_ENABLED',
  'SENTRY_RELEASE',
  'APP_VERSION',
  'RAILWAY_GIT_COMMIT_SHA',
  'GIT_COMMIT',
  'RENDER_GIT_COMMIT',
  'VERCEL_GIT_COMMIT_SHA',
  'GITHUB_SHA',
  'OTEL_AWS_APPLICATION_SIGNALS_ENABLED',
  'NODE_OPTIONS',
] as const;

describe('Sentry monitoring bootstrap', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(MONITORED_KEYS.map((key) => [key, process.env[key]]));
    for (const key of MONITORED_KEYS) delete process.env[key];
    initMock.mockClear();
    captureExceptionMock.mockClear();
    resetSentryStateForTesting();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSentryStateForTesting();
  });

  describe('initialisation gating', () => {
    it('is a no-op when no DSN is configured', () => {
      initSentry();
      expect(initMock).not.toHaveBeenCalled();
      expect(isSentryEnabled()).toBe(false);
    });

    it('initialises when a DSN is present', () => {
      process.env['SENTRY_DSN'] = 'https://key@example.ingest.sentry.io/1';
      initSentry();
      expect(initMock).toHaveBeenCalledTimes(1);
      expect(isSentryEnabled()).toBe(true);
    });

    it('does NOT initialise when SENTRY_ENABLED=false even though a DSN exists', () => {
      process.env['SENTRY_DSN'] = 'https://key@example.ingest.sentry.io/1';
      process.env['SENTRY_ENABLED'] = 'false';

      initSentry();

      expect(initMock).not.toHaveBeenCalled();
      expect(isSentryEnabled()).toBe(false);
    });

    it('treats any value other than the exact string "false" as not-disabled', () => {
      process.env['SENTRY_DSN'] = 'https://key@example.ingest.sentry.io/1';
      process.env['SENTRY_ENABLED'] = 'FALSE';
      initSentry();
      expect(initMock).toHaveBeenCalledTimes(1);
    });

    it('exposes the same gating decision through isSentryConfigured', () => {
      const dsn = 'https://key@example.ingest.sentry.io/1';
      expect(isSentryConfigured((key) => ({ SENTRY_DSN: dsn })[key])).toBe(true);
      expect(isSentryConfigured((key) => ({ SENTRY_DSN: dsn, SENTRY_ENABLED: 'false' })[key])).toBe(
        false,
      );
      expect(isSentryConfigured(() => undefined)).toBe(false);
    });
  });

  describe('release tagging', () => {
    it('attaches the resolved release to every event', () => {
      process.env['SENTRY_DSN'] = 'https://key@example.ingest.sentry.io/1';
      process.env['RAILWAY_GIT_COMMIT_SHA'] = 'abc123';

      initSentry();

      expect(initMock).toHaveBeenCalledWith(expect.objectContaining({ release: 'abc123' }));
    });

    it('omits release entirely when nothing identifies the build', () => {
      process.env['SENTRY_DSN'] = 'https://key@example.ingest.sentry.io/1';
      initSentry();
      expect(initMock.mock.calls[0]?.[0]).not.toHaveProperty('release');
    });

    it('never sends PII by default', () => {
      process.env['SENTRY_DSN'] = 'https://key@example.ingest.sentry.io/1';
      initSentry();
      expect(initMock).toHaveBeenCalledWith(expect.objectContaining({ sendDefaultPii: false }));
    });
  });

  describe('coexistence with AWS Distro for OpenTelemetry', () => {
    it('keeps Sentry tracing when ADOT is not active', () => {
      process.env['SENTRY_DSN'] = 'https://key@example.ingest.sentry.io/1';
      initSentry();
      expect(initMock.mock.calls[0]?.[0]).not.toHaveProperty('skipOpenTelemetrySetup');
      expect(initMock).toHaveBeenCalledWith(expect.objectContaining({ tracesSampleRate: 0.1 }));
    });

    it('leaves the tracer provider to ADOT and only captures errors when Application Signals is on', () => {
      process.env['SENTRY_DSN'] = 'https://key@example.ingest.sentry.io/1';
      process.env['OTEL_AWS_APPLICATION_SIGNALS_ENABLED'] = 'true';
      initSentry();
      expect(initMock).toHaveBeenCalledWith(
        expect.objectContaining({ skipOpenTelemetrySetup: true, tracesSampleRate: 0 }),
      );
    });

    it('detects the ADOT agent from NODE_OPTIONS as well', () => {
      process.env['SENTRY_DSN'] = 'https://key@example.ingest.sentry.io/1';
      process.env['NODE_OPTIONS'] = '--require /otel-auto-instrumentation-node/autoinstrumentation.js';
      initSentry();
      expect(initMock).toHaveBeenCalledWith(expect.objectContaining({ skipOpenTelemetrySetup: true }));
    });
  });

  describe('captureHandledException', () => {
    const context = {
      requestId: 'req-1',
      method: 'POST',
      route: '/api/v1/payments',
      status: 500,
    };

    it('reports a handled server error once Sentry is initialised', () => {
      process.env['SENTRY_DSN'] = 'https://key@example.ingest.sentry.io/1';
      initSentry();

      const error = new Error('boom');
      captureHandledException(error, context);

      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      expect(captureExceptionMock).toHaveBeenCalledWith(error);
    });

    it('is a no-op when Sentry is not initialised', () => {
      captureHandledException(new Error('boom'), context);
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    it('never reports the same error object twice', () => {
      process.env['SENTRY_DSN'] = 'https://key@example.ingest.sentry.io/1';
      initSentry();

      const error = new Error('boom');
      captureHandledException(error, context);
      captureHandledException(error, context);

      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });

    it('does not re-report an error the process handlers later observe', () => {
      process.env['SENTRY_DSN'] = 'https://key@example.ingest.sentry.io/1';
      initSentry();
      registerGlobalErrorHandlers();

      const error = new Error('escaped after responding');
      captureHandledException(error, context);
      process.emit('unhandledRejection', error, Promise.resolve());

      expect(captureExceptionMock).toHaveBeenCalledTimes(1);

      process.removeAllListeners('unhandledRejection');
      process.removeAllListeners('uncaughtException');
    });
  });

  describe('scrubSentryEvent', () => {
    it('drops the request body, cookies and credential headers', () => {
      const event = scrubSentryEvent({
        request: {
          data: { password: 'hunter2', cardNumber: '4111111111111111' },
          cookies: 'access_token=abc',
          headers: {
            Authorization: 'Bearer secret',
            Cookie: 'access_token=abc',
            'x-csrf-token': 'csrf',
            'X-Api-Key': 'k',
            'user-agent': 'Mozilla/5.0',
            'content-type': 'application/json',
          },
        },
      });

      expect(event.request?.data).toBeUndefined();
      expect(event.request?.cookies).toBeUndefined();
      expect(event.request?.headers).toEqual({
        'user-agent': 'Mozilla/5.0',
        'content-type': 'application/json',
      });
    });

    it('redacts sensitive query-string parameters in both query_string and url', () => {
      const event = scrubSentryEvent({
        request: {
          query_string: 'page=2&token=abcdef&hmac=deadbeef',
          url: 'https://api.example.com/webhook?hmac=deadbeef&order=42',
        },
      });

      expect(event.request?.query_string).toBe('page=2&token=[redacted]&hmac=[redacted]');
      expect(event.request?.url).toBe('https://api.example.com/webhook?hmac=[redacted]&order=42');
    });

    it('keeps the user id and role but removes contact details', () => {
      const event = scrubSentryEvent({
        user: {
          id: 'user-1',
          role: 'teacher',
          email: 'teacher@example.com',
          username: 'teacher',
          ip_address: '203.0.113.5',
          phone: '+201234567890',
        },
      });

      expect(event.user).toEqual({ id: 'user-1', role: 'teacher' });
    });

    it('tolerates an event with no request or user', () => {
      expect(() => scrubSentryEvent({})).not.toThrow();
    });
  });
});
