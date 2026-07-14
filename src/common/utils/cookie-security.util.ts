import type { Request } from 'express';

export interface CrossSiteCookieOptions {
  secure: boolean;
  sameSite: 'none' | 'lax';
  partitioned: boolean;
}

/**
 * Production uses a cross-site SPA/API topology, so cookies must be
 * `SameSite=None; Secure`. Secure is unconditional in production: a broken TLS
 * or proxy setup must fail closed instead of downgrading credentials to HTTP.
 * Development/test use Lax, non-Secure cookies so localhost remains usable.
 *
 * The request parameter is retained so all cookie callers share one API and so
 * deployments can later adopt a same-site topology without scattered changes.
 */
export function getCrossSiteCookieOptions(_request: Request): CrossSiteCookieOptions {
  const isProduction = process.env['NODE_ENV'] === 'production';
  return {
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    partitioned: isProduction,
  };
}
