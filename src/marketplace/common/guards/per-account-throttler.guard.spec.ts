import { PayoutRequestThrottlerGuard, PerAccountThrottlerGuard, RefundRequestThrottlerGuard } from './per-account-throttler.guard';

/**
 * `ThrottlerGuard`'s own constructor needs its module options/storage/
 * reflector — not relevant to what these guards override. Testing the two
 * overridden protected methods directly (via a bare prototype instance)
 * covers the actual behavioural change without wiring up the rest of
 * `@nestjs/throttler`, which `canActivate()`'s end-to-end behavior already
 * has its own upstream test coverage for.
 */
function bareInstance<T extends new () => object>(ctor: T): InstanceType<T> {
  return Object.create(ctor.prototype) as InstanceType<T>;
}

describe.each([
  { name: 'PerAccountThrottlerGuard', Ctor: PerAccountThrottlerGuard, code: 'FREE_ENROLLMENT_RATE_LIMITED' },
  { name: 'RefundRequestThrottlerGuard', Ctor: RefundRequestThrottlerGuard, code: 'REFUND_REQUEST_RATE_LIMITED' },
  { name: 'PayoutRequestThrottlerGuard', Ctor: PayoutRequestThrottlerGuard, code: 'PAYOUT_REQUEST_RATE_LIMITED' },
])('$name (T209)', ({ Ctor, code }) => {
  it('tracks by account id when the request is authenticated', async () => {
    const guard = bareInstance(Ctor) as unknown as { getTracker: (req: Record<string, unknown>) => Promise<string> };
    const tracker = await guard.getTracker({ user: { userId: 'account-1' } });
    expect(tracker).toBe('account:account-1');
  });

  it('falls back to the base IP tracker when there is no authenticated user', async () => {
    const guard = bareInstance(Ctor) as unknown as { getTracker: (req: Record<string, unknown>) => Promise<string> };
    await expect(guard.getTracker({ ip: '203.0.113.5' })).resolves.toBe('203.0.113.5');
  });

  it(`refuses with ${code} naming the per-minute limit, not the throttler default`, async () => {
    const guard = bareInstance(Ctor) as unknown as { throwThrottlingException: (ctx: unknown) => Promise<void> };
    let caught: unknown;
    try {
      await guard.throwThrottlingException({});
    } catch (error) {
      caught = error;
    }
    const body = (caught as { getResponse(): { code: string; details: string[] } }).getResponse();
    expect(body.code).toBe(code);
    expect(body.details).toEqual(['per_minute']);
  });
});

describe('feature-specific guards never cross-label each other\'s refusals', () => {
  it('the refund and payout guards do not throw FREE_ENROLLMENT_RATE_LIMITED', async () => {
    for (const Ctor of [RefundRequestThrottlerGuard, PayoutRequestThrottlerGuard]) {
      const guard = bareInstance(Ctor) as unknown as { throwThrottlingException: (ctx: unknown) => Promise<void> };
      let caught: unknown;
      try {
        await guard.throwThrottlingException({});
      } catch (error) {
        caught = error;
      }
      const body = (caught as { getResponse(): { code: string } }).getResponse();
      expect(body.code).not.toBe('FREE_ENROLLMENT_RATE_LIMITED');
    }
  });
});
