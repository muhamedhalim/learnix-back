import { exponentialRetryDelayMs } from './backoff.util';

describe('exponentialRetryDelayMs', () => {
  it('starts at 30 seconds and doubles per attempt', () => {
    expect(exponentialRetryDelayMs(0)).toBe(30_000);
    expect(exponentialRetryDelayMs(1)).toBe(60_000);
    expect(exponentialRetryDelayMs(2)).toBe(120_000);
    expect(exponentialRetryDelayMs(5)).toBe(960_000);
  });

  it('is capped at one hour', () => {
    expect(exponentialRetryDelayMs(7)).toBe(3_600_000);
    expect(exponentialRetryDelayMs(8)).toBe(3_600_000);
    expect(exponentialRetryDelayMs(500)).toBe(3_600_000);
  });

  it('matches the formula it replaced for every attempt count the callers can reach', () => {
    for (let attempts = 0; attempts <= 50; attempts += 1) {
      expect(exponentialRetryDelayMs(attempts)).toBe(
        Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts, 7)),
      );
    }
  });
});
