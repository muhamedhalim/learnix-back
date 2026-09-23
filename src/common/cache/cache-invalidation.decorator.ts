import { SetMetadata } from '@nestjs/common';

import type { ApplicationCacheFamily } from './application-cache.service';

export const SKIP_CACHE_INVALIDATION_KEY = 'cache:skip-invalidation';
export const INVALIDATES_CACHE_KEY = 'cache:invalidates';

/**
 * Marks a mutating route as writing NO table that any application-cache family
 * reads, so a successful call must not advance the global cache generation.
 *
 * Only add this after proving the route's success path writes none of the
 * tables read by any family's `compute`. Verified exemptions (T030):
 *  - `user_sessions` (login, refresh, logout);
 *  - `notifications.is_read` / `read_at` (notification read, read-all);
 *  - `exam_attempt_answers` of IN_PROGRESS attempts (exam autosave; exam
 *    analytics reads answers only for GRADED attempts);
 *  - nothing at all (dry-run previews).
 *
 * A future cache family that reads any of these tables MUST first remove the
 * exemption from every affected route (rule 6 review in
 * `specs/004-api-db-efficiency-audit/contracts/cache-invalidation.md`).
 */
export const SkipCacheInvalidation = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_CACHE_INVALIDATION_KEY, true);

/**
 * One invalidation target of a declared route: a whole family, or only the
 * requesting principal's own slice of an owner-scoped family.
 *
 * `{ family, scope: 'self' }` resolves to `owner:<request.user.userId>` and is
 * ONLY correct when the principal is the owner of every row the route writes in
 * that family. If a write can affect another owner (a teacher grading a
 * student's answer), declare the whole family or invalidate the affected owner
 * from the service with `ApplicationCacheService.invalidateScopes`.
 */
export type CacheInvalidationTarget =
  | ApplicationCacheFamily
  | { family: ApplicationCacheFamily; scope: 'self' };

/**
 * Declares exactly which cache families a successful mutating route
 * invalidates, instead of the global fallback.
 *
 * Declare a route only after listing the tables its success path writes and
 * the families whose `compute` reads them; an omitted family serves stale data
 * until its TTL expires. An empty list is rejected: a route that writes no
 * cached table must use `@SkipCacheInvalidation()` instead.
 *
 * When a `self` target is declared but the request has no principal, the
 * interceptor falls back to invalidating the whole family — it never skips.
 */
export const InvalidatesCache = (
  targets: readonly CacheInvalidationTarget[],
): MethodDecorator & ClassDecorator => {
  if (targets.length === 0) {
    throw new Error(
      '@InvalidatesCache() requires at least one target; use @SkipCacheInvalidation() for routes that write no cached table',
    );
  }
  return SetMetadata(INVALIDATES_CACHE_KEY, [...targets]);
};
