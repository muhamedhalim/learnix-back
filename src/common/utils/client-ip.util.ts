import type { Request } from 'express';

/**
 * The client IP recorded on audit-style rows (login attempts, lesson sessions,
 * request performance traces).
 *
 * ## Why this exists
 * Three call sites had independently inlined this same expression, and one of
 * them (`SessionController.enterLesson`) asserted the header to a bare `string`
 * and called `.split()` on it unguarded. `x-forwarded-for` is absent on any
 * request that did not pass through the proxy — a direct hit, a misconfigured
 * ingress, an internal probe — so that call threw `TypeError: Cannot read
 * properties of undefined (reading 'split')` and turned "start a lesson" into a
 * 500 before the `?? request.ip` fallback could ever be reached (AUD-001).
 *
 * ## Semantics (unchanged from the previous behaviour)
 * First hop of `x-forwarded-for` when the proxy supplied one, otherwise
 * Express's own `request.ip`. `main.ts` sets `trust proxy = 1`, so `request.ip`
 * is itself proxy-aware and is a correct fallback rather than a degraded one.
 *
 * Node can surface a repeated header as `string[]`; only a non-empty `string`
 * is accepted, and a header that is present but blank (`''`, `'   '`, `','`)
 * falls through to `request.ip` instead of recording an empty address.
 *
 * Returns `null` when neither source yields a value, which every caller already
 * stores as a nullable column.
 */
export function getClientIp(request: Pick<Request, 'headers' | 'ip'>): string | null {
  const forwarded = request.headers['x-forwarded-for'];

  if (typeof forwarded === 'string') {
    const firstHop = forwarded.split(',')[0]?.trim();
    if (firstHop !== undefined && firstHop !== '') {
      return firstHop;
    }
  }

  return request.ip ?? null;
}
