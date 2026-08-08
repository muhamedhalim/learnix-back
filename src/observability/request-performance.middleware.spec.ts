import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { getCurrentRequestId, requestPerformanceStorage } from './performance-context';
import { RequestPerformanceMiddleware } from './request-performance.middleware';
import { QueryPerformanceSubscriber } from './query-performance.subscriber';

interface Harness {
  request: Request;
  response: Response;
  finish: () => void;
  responseHeaders: Record<string, string>;
}

function buildHarness(headers: Record<string, string> = {}): Harness {
  const listeners: Record<string, () => void> = {};
  const responseHeaders: Record<string, string> = {};
  const request = {
    method: 'GET',
    url: '/api/v1/packages',
    path: '/api/v1/packages',
    baseUrl: '/api/v1',
    route: { path: '/packages' },
    headers: { ...headers },
    ip: '203.0.113.5',
  } as unknown as Request;

  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      responseHeaders[name] = value;
    },
    getHeader() {
      return undefined;
    },
    once(eventName: string, handler: () => void) {
      listeners[eventName] = handler;
      return this;
    },
  } as unknown as Response;

  return {
    request,
    response,
    responseHeaders,
    finish: () => listeners['finish']?.(),
  };
}

describe('RequestPerformanceMiddleware — canonical request id', () => {
  const middleware = new RequestPerformanceMiddleware();

  it('mints one id and echoes it on the response header', () => {
    const { request, response, responseHeaders } = buildHarness();
    let seenInsideHandler: string | undefined;

    middleware.use(request, response, (() => {
      seenInsideHandler = getCurrentRequestId();
    }) as unknown as NextFunction);

    expect(seenInsideHandler).toBeDefined();
    expect(responseHeaders['X-Request-Id']).toBe(seenInsideHandler);
  });

  it('honours a well-formed inbound X-Request-Id', () => {
    const { request, response, responseHeaders } = buildHarness({
      'x-request-id': 'gateway-abc-123',
    });
    let seen: string | undefined;

    middleware.use(request, response, (() => {
      seen = getCurrentRequestId();
    }) as unknown as NextFunction);

    expect(seen).toBe('gateway-abc-123');
    expect(responseHeaders['X-Request-Id']).toBe('gateway-abc-123');
  });

  it('replaces a malformed inbound id instead of echoing it (header/log injection)', () => {
    const { request, response, responseHeaders } = buildHarness({
      'x-request-id': 'evil\r\nX-Admin: true',
    });

    middleware.use(request, response, (() => undefined) as unknown as NextFunction);

    expect(responseHeaders['X-Request-Id']).not.toContain('X-Admin');
    expect(responseHeaders['X-Request-Id']).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
  });

  it('normalises the request header so later readers see the canonical value', () => {
    const { request, response } = buildHarness();

    middleware.use(request, response, (() => undefined) as unknown as NextFunction);

    expect(request.headers['x-request-id']).toBe(getCurrentRequestIdFrom(request));
  });

  function getCurrentRequestIdFrom(request: Request): string | undefined {
    const value = request.headers['x-request-id'];
    return Array.isArray(value) ? value[0] : value;
  }
});

describe('one request uses one id across every observability surface', () => {
  it('emits the same id in the access log, the query log, the error body and the error header', () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    try {
      const middleware = new RequestPerformanceMiddleware();
      const subscriber = new QueryPerformanceSubscriber();
      const filter = new HttpExceptionFilter();
      const { request, response, responseHeaders, finish } = buildHarness();

      const errorResponseHeaders: Record<string, string> = {};
      let errorBody: Record<string, unknown> | undefined;
      const filterHost = {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({
            setHeader: (name: string, value: string) => {
              errorResponseHeaders[name] = value;
            },
            status: () => ({
              json: (payload: Record<string, unknown>) => {
                errorBody = payload;
              },
            }),
          }),
        }),
      } as never;

      middleware.use(request, response, (() => {
        // A slow query inside the request…
        subscriber.afterQuery({
          query: 'SELECT 1',
          success: true,
          executionTime: 500,
        } as never);
        // …then the request fails and the global filter handles it.
        (response as { statusCode: number }).statusCode = 500;
        filter.catch(new Error('boom'), filterHost);
      }) as unknown as NextFunction);

      finish();

      const canonical = responseHeaders['X-Request-Id'];
      expect(canonical).toBeDefined();

      // 1. Error response body + header (what a user quotes to support).
      expect(errorBody?.requestId).toBe(canonical);
      expect(errorResponseHeaders['X-Request-Id']).toBe(canonical);

      // 2. The HTTP access log line.
      const accessLog = logSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"event":"http_request"'));
      expect(accessLog).toBeDefined();
      expect(JSON.parse(accessLog!).requestId).toBe(canonical);

      // 3. The database timing log line.
      const queryLog = logSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"event":"database_query_performance"'));
      expect(queryLog).toBeDefined();
      expect(JSON.parse(queryLog!).requestId).toBe(canonical);

      // 4. The exception log line.
      const exceptionLog = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(exceptionLog).toContain(`[${canonical}]`);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('logs release and environment so an error spike can be attributed to a deployment', () => {
    const previous = process.env['SENTRY_RELEASE'];
    process.env['SENTRY_RELEASE'] = 'release-under-test';
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    try {
      // Constructed after the env var is set: release is resolved once per instance.
      const middleware = new RequestPerformanceMiddleware();
      const { request, response, finish } = buildHarness();

      middleware.use(request, response, (() => undefined) as unknown as NextFunction);
      finish();

      const accessLog = logSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"event":"http_request"'));
      const parsed = JSON.parse(accessLog!);
      expect(parsed.release).toBe('release-under-test');
      expect(parsed.environment).toBeDefined();
    } finally {
      logSpy.mockRestore();
      if (previous === undefined) delete process.env['SENTRY_RELEASE'];
      else process.env['SENTRY_RELEASE'] = previous;
    }
  });

  it('does not leak the principal beyond id and role', () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const middleware = new RequestPerformanceMiddleware();
      const { request, response, finish } = buildHarness();
      (request as unknown as { user: unknown }).user = {
        userId: 'u-1',
        role: 'student',
        email: 'student@example.com',
        name: 'Real Name',
      };

      middleware.use(request, response, (() => undefined) as unknown as NextFunction);
      finish();

      const accessLog = logSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"event":"http_request"'));
      expect(accessLog).toContain('"userId":"u-1"');
      expect(accessLog).toContain('"role":"student"');
      expect(accessLog).not.toContain('student@example.com');
      expect(accessLog).not.toContain('Real Name');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('performance context isolation', () => {
  it('leaves no ambient request id outside a request', () => {
    expect(requestPerformanceStorage.getStore()).toBeUndefined();
    expect(getCurrentRequestId()).toBeUndefined();
  });
});
