import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PaymentsWebhookController } from '../../payments/controllers/payments-webhook.controller';
import { CsrfGuard } from './csrf.guard';

function buildContext(
  request: Record<string, unknown>,
  response: Record<string, unknown> = {},
  handler: unknown = () => undefined,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getHandler: () => handler,
    getClass: () => class {} as unknown,
  } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
  let guard: CsrfGuard;

  beforeEach(() => {
    guard = new CsrfGuard(new Reflector());
  });

  it('issues a fresh cookie on a safe GET request with no existing cookie', () => {
    const cookieCalls: unknown[] = [];
    const request = { method: 'GET', url: '/auth/csrf-token', signedCookies: {}, headers: {} };
    const response = { cookie: (...args: unknown[]) => cookieCalls.push(args) };

    const result = guard.canActivate(buildContext(request, response));

    expect(result).toBe(true);
    expect(cookieCalls).toHaveLength(1);
    expect((request as { csrfToken?: string }).csrfToken).toEqual(expect.any(String));
  });

  it(
    'issues a fresh cookie (does not reuse a stale token) when cookie-parser reports a failed ' +
      'signature verification as `false`',
    () => {
      // cookie-parser sets signedCookies[name] = false (not undefined) when a
      // signed cookie's signature fails to verify (e.g. after a COOKIE_SECRET
      // rotation, or a tampered value) — see node_modules/cookie-parser.
      const cookieCalls: unknown[] = [];
      const request = {
        method: 'GET',
        url: '/auth/csrf-token',
        signedCookies: { 'XSRF-TOKEN': false },
        headers: {},
      };
      const response = { cookie: (...args: unknown[]) => cookieCalls.push(args) };

      guard.canActivate(buildContext(request, response));

      // A fresh cookie must be issued — the guard must not treat `false` as a
      // usable existing token.
      expect(cookieCalls).toHaveLength(1);
      expect((request as { csrfToken?: unknown }).csrfToken).not.toBe(false);
      expect(typeof (request as { csrfToken?: unknown }).csrfToken).toBe('string');
    },
  );

  it('reuses an existing valid string cookie without re-issuing one', () => {
    const cookieCalls: unknown[] = [];
    const request = {
      method: 'GET',
      url: '/auth/csrf-token',
      signedCookies: { 'XSRF-TOKEN': 'existing-token-value' },
      headers: {},
    };
    const response = { cookie: (...args: unknown[]) => cookieCalls.push(args) };

    guard.canActivate(buildContext(request, response));

    expect(cookieCalls).toHaveLength(0);
    expect((request as { csrfToken?: string }).csrfToken).toBe('existing-token-value');
  });

  it('rejects a POST with a matching cookie/header pair absent (both missing)', () => {
    const request = {
      method: 'POST',
      url: '/api/v1/auth/login',
      signedCookies: {},
      headers: {},
      ip: '127.0.0.1',
    };

    expect(() => guard.canActivate(buildContext(request))).toThrow(ForbiddenException);
  });

  it('rejects a POST when the cookie failed signature verification (false), even with a header present', () => {
    const request = {
      method: 'POST',
      url: '/api/v1/auth/login',
      signedCookies: { 'XSRF-TOKEN': false },
      headers: { 'x-csrf-token': 'some-header-value' },
      ip: '127.0.0.1',
    };

    expect(() => guard.canActivate(buildContext(request))).toThrow(ForbiddenException);
  });

  it('allows a POST when the cookie and header match', () => {
    const request = {
      method: 'POST',
      url: '/api/v1/auth/login',
      signedCookies: { 'XSRF-TOKEN': 'matching-token' },
      headers: { 'x-csrf-token': 'matching-token' },
      ip: '127.0.0.1',
    };

    expect(guard.canActivate(buildContext(request))).toBe(true);
  });

  it.each([
    ['payments webhook', PaymentsWebhookController.prototype.handleWebhook],
    ['payments callback', PaymentsWebhookController.prototype.handleCallback],
  ])('allows the %s POST to reach its HMAC validation without browser CSRF', (_, handler) => {
    const request = {
      method: 'POST',
      url: '/api/v1/payments/webhook',
      signedCookies: {},
      headers: {},
      ip: '127.0.0.1',
    };

    expect(guard.canActivate(buildContext(request, {}, handler))).toBe(true);
  });

  it('rejects a POST when cookie and header are both present but differ (same length)', () => {
    // Same-length, different value — exercises the constant-time comparison
    // path rather than the length short-circuit.
    const request = {
      method: 'POST',
      url: '/api/v1/auth/login',
      signedCookies: { 'XSRF-TOKEN': 'aaaaaaaaaaaaaaaa' },
      headers: { 'x-csrf-token': 'bbbbbbbbbbbbbbbb' },
      ip: '127.0.0.1',
    };

    expect(() => guard.canActivate(buildContext(request))).toThrow(ForbiddenException);
  });

  it('rejects a POST when cookie and header differ in length', () => {
    const request = {
      method: 'POST',
      url: '/api/v1/auth/login',
      signedCookies: { 'XSRF-TOKEN': 'short' },
      headers: { 'x-csrf-token': 'a-much-longer-token-value' },
      ip: '127.0.0.1',
    };

    expect(() => guard.canActivate(buildContext(request))).toThrow(ForbiddenException);
  });
});
