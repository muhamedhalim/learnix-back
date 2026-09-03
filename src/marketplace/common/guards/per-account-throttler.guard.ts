import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import { freeEnrollmentRateLimited } from '../errors';

/**
 * FR-121 — the free-enrollment per-minute cap is per **account**, not per
 * IP (several learners sharing a network, or one learner switching
 * networks, must not be conflated with each other). Keys the throttler's
 * existing (Redis-backed in production) storage by the authenticated
 * `userId` instead of the request IP `ThrottlerGuard` defaults to, falling
 * back to IP only for the (never-expected-in-practice) case of no
 * authenticated user, so this never throws on a malformed request instead
 * of just rate-limiting it. Runs alongside, not instead of, the app-wide
 * IP-based `ThrottlerGuard` already installed as `APP_GUARD` — this is an
 * additional, narrower check for one route, not a replacement. Overrides
 * the refusal itself too, so a per-minute breach states `FREE_ENROLLMENT_RATE_LIMITED`
 * with `limit: 'per_minute'` (FR-121's "the limit that was reached stated
 * on refusal") instead of the throttler's generic 429.
 */
@Injectable()
export class PerAccountThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = (req['user'] as { userId?: string } | undefined)?.userId;
    if (userId) return `account:${userId}`;
    return super.getTracker(req);
  }

  protected override async throwThrottlingException(_context: ExecutionContext): Promise<void> {
    throw freeEnrollmentRateLimited('per_minute');
  }
}
