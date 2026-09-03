import { PerAccountThrottlerGuard } from './per-account-throttler.guard';

/**
 * `ThrottlerGuard`'s own constructor needs its module options/storage/
 * reflector — not relevant to what this guard overrides. Testing the two
 * overridden protected methods directly (via a bare prototype instance)
 * covers the actual behavioural change without wiring up the rest of
 * `@nestjs/throttler`, which `canActivate()`'s end-to-end behavior already
 * has its own upstream test coverage for.
 */
function bareInstance(): PerAccountThrottlerGuard {
  return Object.create(PerAccountThrottlerGuard.prototype) as PerAccountThrottlerGuard;
}

describe('PerAccountThrottlerGuard', () => {
  it('tracks by account id when the request is authenticated', async () => {
    const guard = bareInstance() as unknown as { getTracker: (req: Record<string, unknown>) => Promise<string> };
    const tracker = await guard.getTracker({ user: { userId: 'learner-1' } });
    expect(tracker).toBe('account:learner-1');
  });

  it('falls back to the base IP tracker when there is no authenticated user', async () => {
    const guard = bareInstance() as unknown as { getTracker: (req: Record<string, unknown>) => Promise<string> };
    await expect(guard.getTracker({ ip: '203.0.113.5' })).resolves.toBe('203.0.113.5');
  });

  it('refuses with FREE_ENROLLMENT_RATE_LIMITED naming the per-minute limit, not the throttler default', async () => {
    const guard = bareInstance() as unknown as { throwThrottlingException: (ctx: unknown) => Promise<void> };
    let caught: unknown;
    try {
      await guard.throwThrottlingException({});
    } catch (error) {
      caught = error;
    }
    const body = (caught as { getResponse(): { code: string; details: string[] } }).getResponse();
    expect(body.code).toBe('FREE_ENROLLMENT_RATE_LIMITED');
    expect(body.details).toEqual(['per_minute']);
  });
});
