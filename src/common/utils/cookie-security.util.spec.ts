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

  it('uses SameSite=None/Secure/Partitioned in production over HTTPS', () => {
    process.env['NODE_ENV'] = 'production';

    const result = getCrossSiteCookieOptions(mockRequest(true));

    expect(result).toEqual({ secure: true, sameSite: 'none', partitioned: true });
  });

  it('keeps Secure cookies in production when TLS forwarding is misconfigured', () => {
    process.env['NODE_ENV'] = 'production';

    const result = getCrossSiteCookieOptions(mockRequest(false));

    expect(result).toEqual({ secure: true, sameSite: 'none', partitioned: true });
  });

  it('uses secure cross-site cookies for HTTPS even when NODE_ENV is misconfigured', () => {
    process.env['NODE_ENV'] = 'development';

    const result = getCrossSiteCookieOptions(mockRequest(true));

    expect(result).toEqual({ secure: true, sameSite: 'none', partitioned: true });
  });

  it('uses Lax/non-Secure in development over plain HTTP (typical localhost)', () => {
    process.env['NODE_ENV'] = 'development';

    const result = getCrossSiteCookieOptions(mockRequest(false));

    expect(result).toEqual({ secure: false, sameSite: 'lax', partitioned: false });
  });
});
