const captureHandledExceptionMock = jest.fn();

jest.mock('../../observability/sentry', () => ({
  captureHandledException: (...args: unknown[]) => captureHandledExceptionMock(...args),
}));

import type { ArgumentsHost } from '@nestjs/common';
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import {
  createRequestPerformanceContext,
  requestPerformanceStorage,
} from '../../observability/performance-context';
import { HttpExceptionFilter } from './http-exception.filter';

interface Captured {
  statusCode?: number;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

function buildHost(options: { headers?: Record<string, string>; user?: unknown } = {}): {
  host: ArgumentsHost;
  captured: Captured;
} {
  const captured: Captured = { headers: {} };
  const response = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    status(code: number) {
      captured.statusCode = code;
      return {
        json(payload: Record<string, unknown>) {
          captured.body = payload;
        },
      };
    },
  };
  const request = {
    method: 'POST',
    url: '/api/v1/payments/checkout',
    path: '/api/v1/payments/checkout',
    baseUrl: '/api/v1',
    route: { path: '/payments/checkout' },
    headers: options.headers ?? {},
    ...(options.user === undefined ? {} : { user: options.user }),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, captured };
}

describe('HttpExceptionFilter — Sentry reporting', () => {
  const filter = new HttpExceptionFilter();

  beforeEach(() => captureHandledExceptionMock.mockClear());

  describe('what gets reported', () => {
    it('reports an unexpected server error (a handled production 500 reaches Sentry)', () => {
      const { host } = buildHost();
      const error = new Error('database connection lost');

      filter.catch(error, host);

      expect(captureHandledExceptionMock).toHaveBeenCalledTimes(1);
      expect(captureHandledExceptionMock).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          status: 500,
          method: 'POST',
          route: '/api/v1/payments/checkout',
        }),
      );
    });

    it('reports an explicit 5xx HttpException', () => {
      const { host } = buildHost();
      filter.catch(new InternalServerErrorException('upstream failed'), host);
      expect(captureHandledExceptionMock).toHaveBeenCalledTimes(1);
    });

    it('reports a 503 so a dependency outage is visible', () => {
      const { host } = buildHost();
      filter.catch(new ServiceUnavailableException('redis down'), host);
      expect(captureHandledExceptionMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['400', new BadRequestException('invalid')],
      ['401', new UnauthorizedException()],
      ['403', new ForbiddenException()],
      ['404', new NotFoundException()],
    ])('does NOT report an expected %s client error', (_label, exception) => {
      const { host } = buildHost();
      filter.catch(exception, host);
      expect(captureHandledExceptionMock).not.toHaveBeenCalled();
    });

    it('does not report a validation failure array', () => {
      const { host } = buildHost();
      filter.catch(new BadRequestException({ message: ['name must be a string'] }), host);
      expect(captureHandledExceptionMock).not.toHaveBeenCalled();
    });
  });

  describe('reported context', () => {
    it('attaches the authenticated principal without contact details', () => {
      const { host } = buildHost({
        user: { userId: 'user-9', role: 'teacher', email: 'teacher@example.com' },
      });

      filter.catch(new Error('boom'), host);

      const context = captureHandledExceptionMock.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(context).toMatchObject({ userId: 'user-9', role: 'teacher' });
      expect(context).not.toHaveProperty('email');
    });

    it('reports the matched route pattern, never the raw url', () => {
      const { host } = buildHost();
      filter.catch(new Error('boom'), host);
      const context = captureHandledExceptionMock.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(context['route']).toBe('/api/v1/payments/checkout');
    });
  });

  describe('canonical request id', () => {
    it('uses the id from the active request context', () => {
      const context = createRequestPerformanceContext('canonical-id-1');
      const { host, captured } = buildHost();

      requestPerformanceStorage.run(context, () => {
        filter.catch(new Error('boom'), host);
      });

      // Same id in the response body, the response header, and Sentry.
      expect(captured.body?.requestId).toBe('canonical-id-1');
      expect(captured.headers['X-Request-Id']).toBe('canonical-id-1');
      expect(captureHandledExceptionMock.mock.calls[0]?.[1]).toMatchObject({
        requestId: 'canonical-id-1',
      });
    });

    it('falls back to the normalised request header outside a context', () => {
      const { host, captured } = buildHost({ headers: { 'x-request-id': 'from-header' } });
      filter.catch(new Error('boom'), host);
      expect(captured.body?.requestId).toBe('from-header');
      expect(captured.headers['X-Request-Id']).toBe('from-header');
    });

    it('rejects a malformed inbound id rather than echoing it back', () => {
      const { host, captured } = buildHost({
        headers: { 'x-request-id': 'bad id\r\nInjected: header' },
      });

      filter.catch(new Error('boom'), host);

      expect(captured.body?.requestId).not.toContain('Injected');
      expect(captured.body?.requestId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
    });
  });

  describe('stack traces', () => {
    it('logs the stack server-side in production but never returns it to the client', () => {
      const previous = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const { host, captured } = buildHost();
      const error = new Error('internal detail');

      try {
        filter.catch(error, host);

        // The stack IS written to the server log — previously it was dropped
        // in production, leaving a 500 with no trace anywhere.
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0]?.[1]).toBe(error.stack);
        expect(errorSpy.mock.calls[0]?.[1]).toContain('http-exception.filter.sentry.spec');

        // …and it is NOT in the client response, along with the raw message.
        const serialisedBody = JSON.stringify(captured.body);
        expect(serialisedBody).not.toContain('internal detail');
        expect(serialisedBody).not.toContain('at Object');
        expect(captured.body?.detail).toBe('An unexpected error occurred. Please try again later.');

        // The error object (with its stack) is what reaches Sentry.
        expect(captureHandledExceptionMock.mock.calls[0]?.[0]).toBe(error);
      } finally {
        errorSpy.mockRestore();
        if (previous === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = previous;
      }
    });
  });
});
