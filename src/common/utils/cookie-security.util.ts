import type { Request } from 'express';

export interface CrossSiteCookieOptions {
  secure: boolean;
  sameSite: 'none' | 'lax';
  partitioned: boolean;
}

/**
 * Derive Secure / SameSite / Partitioned cookie attributes from the *actual*
 * request, not `NODE_ENV` alone.
 *
 * Browsers silently DROP a `Secure` cookie on a response that wasn't served
 * over HTTPS. Gating purely on `NODE_ENV === 'production'` therefore breaks
 * cookie delivery whenever the process's environment says "production" but the
 * request itself arrived over plain HTTP (e.g. `NODE_ENV` leaked from a shell/
 * CI/Railway variable while testing locally, or `start:prod` run without TLS in
 * front) — the browser accepts the `Set-Cookie` response but never stores the
 * cookie, so the next request has no cookie at all. This is the exact failure
 * mode behind a "CSRF token missing" 403 on an otherwise-correct login flow.
 *
 * Both conditions must hold before a cross-site cookie is requested:
 *  - `NODE_ENV=production` (the deployed cross-site topology — SPA and API on
 *    different sites)
 *  - the request is actually secure (`request.secure`, which honours
 *    `X-Forwarded-Proto` because `app.set('trust proxy', 1)` is configured in
 *    `main.ts`, so this is accurate behind Railway's proxy)
 *
 * | | production env | not production env |
 * |---|---|---|
 * | **HTTPS request** | Secure=true, SameSite=None, Partitioned=true | Secure=false, SameSite=Lax |
 * | **HTTP request**  | Secure=false, SameSite=Lax (never a broken Secure cookie) | Secure=false, SameSite=Lax |
 *
 * Used by both the CSRF cookie (`CsrfGuard`) and the refresh-token cookie
 * (`AuthController`) so their attributes never diverge.
 */
export function getCrossSiteCookieOptions(request: Request): CrossSiteCookieOptions {
  const isProductionEnv = process.env['NODE_ENV'] === 'production';
  const isSecureRequest = request.secure;
  const useCrossSiteCookie = isProductionEnv && isSecureRequest;

  return {
    secure: useCrossSiteCookie,
    sameSite: useCrossSiteCookie ? 'none' : 'lax',
    partitioned: useCrossSiteCookie,
  };
}
