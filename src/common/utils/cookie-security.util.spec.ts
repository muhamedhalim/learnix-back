import type { Request } from 'express';

import { getCrossSiteCookieOptions } from './cookie-security.util';

function mockRequest(secure: boolean): Request {
  return { secure } as Request;
}

describe('getCrossSiteCookieOptions', () => {
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
  });

  it('uses SameSite=None/Secure/Partitioned only when production AND the request is actually HTTPS', () => {
    process.env['NODE_ENV'] = 'production';

    const result = getCrossSiteCookieOptions(mockRequest(true));

    expect(result).toEqual({ secure: true, sameSite: 'none', partitioned: true });
  });

  it('falls back to Lax/non-Secure in production when the request is plain HTTP (the reported bug)', () => {
    // Reproduces the exact failure: NODE_ENV says "production" but the request
    // arrived over plain HTTP (e.g. leaked shell env var, or `start:prod` run
    // locally without TLS). A `Secure` cookie here would be silently dropped
    // by the browser, breaking the CSRF double-submit cookie.
    process.env['NODE_ENV'] = 'production';

    const result = getCrossSiteCookieOptions(mockRequest(false));

    expect(result).toEqual({ secure: false, sameSite: 'lax', partitioned: false });
  });

  it('uses Lax/non-Secure in development even over HTTPS', () => {
    process.env['NODE_ENV'] = 'development';

    const result = getCrossSiteCookieOptions(mockRequest(true));

    expect(result).toEqual({ secure: false, sameSite: 'lax', partitioned: false });
  });

  it('uses Lax/non-Secure in development over plain HTTP (typical localhost)', () => {
    process.env['NODE_ENV'] = 'development';

    const result = getCrossSiteCookieOptions(mockRequest(false));

    expect(result).toEqual({ secure: false, sameSite: 'lax', partitioned: false });
  });
});
