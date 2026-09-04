import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import { freeEnrollmentRateLimited, payoutRequestRateLimited, refundRequestRateLimited } from '../errors';

/**
 * FR-121, FR-308 — several money-moving/write routes are rate-limited per
 * **account**, not per IP (several learners or instructors sharing a
 * network, or one person switching networks, must not be conflated with
 * each other). Keys the throttler's existing (Redis-backed in production)
 * storage by the authenticated `userId` instead of the request IP
 * `ThrottlerGuard` defaults to, falling back to IP only for the
 * (never-expected-in-practice) case of no authenticated user, so this never
 * throws on a malformed request instead of just rate-limiting it. Runs
 * alongside, not instead of, the app-wide IP-based `ThrottlerGuard` already
 * installed as `APP_GUARD` — this is an additional, narrower check for one
 * route, not a replacement.
 *
 * Each concrete subclass overrides only the refusal itself, so a breach
 * states the error code and limit for the route that was actually called
 * (FR-308's "the limit that was reached stated on refusal") rather than a
 * generic 429 borrowed from an unrelated feature.
 */
@Injectable()
export abstract class AccountScopedThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = (req['user'] as { userId?: string } | undefined)?.userId;
    if (userId) return `account:${userId}`;
    return super.getTracker(req);
  }
}

/** FR-121 — the free-enrollment per-minute cap. */
@Injectable()
export class PerAccountThrottlerGuard extends AccountScopedThrottlerGuard {
  protected override async throwThrottlingException(_context: ExecutionContext): Promise<void> {
    throw freeEnrollmentRateLimited('per_minute');
  }
}

/** FR-308 — the refund-request per-minute cap. */
@Injectable()
export class RefundRequestThrottlerGuard extends AccountScopedThrottlerGuard {
  protected override async throwThrottlingException(_context: ExecutionContext): Promise<void> {
    throw refundRequestRateLimited('per_minute');
  }
}

/** FR-308 — the payout-request per-minute cap. */
@Injectable()
export class PayoutRequestThrottlerGuard extends AccountScopedThrottlerGuard {
  protected override async throwThrottlingException(_context: ExecutionContext): Promise<void> {
    throw payoutRequestRateLimited('per_minute');
  }
}
