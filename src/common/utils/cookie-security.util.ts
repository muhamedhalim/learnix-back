import type { Request } from 'express';

export interface CrossSiteCookieOptions {
  secure: boolean;
  sameSite: 'none' | 'lax';
  partitioned: boolean;
}

/**
 * A deployed HTTPS API may be misconfigured with `NODE_ENV=development`.
 * The trusted Express proxy signal (`request.secure`) is therefore treated as
 * production-like too: a cross-site SPA needs `SameSite=None; Secure` cookies
 * regardless of that application setting. `main.ts` enables `trust proxy` so
 * this reflects Railway's TLS termination. Plain HTTP localhost keeps Lax,
 * non-Secure cookies for development.
 *
 * The request parameter is retained so all cookie callers share one API and so
 * deployments can later adopt a same-site topology without scattered changes.
 */
export function getCrossSiteCookieOptions(request: Request): CrossSiteCookieOptions {
  const isProductionLike = process.env['NODE_ENV'] === 'production' || request.secure === true;
  return {
    secure: isProductionLike,
    sameSite: isProductionLike ? 'none' : 'lax',
    partitioned: isProductionLike,
  };
}
