import { isRetryableStatus, parseRetryAfter } from './provider-errors';

describe('provider-errors', () => {
  it('classifies 429 and 5xx as retryable, other 4xx as not', () => {
    expect([429, 500, 502, 503, 504].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 409].some(isRetryableStatus)).toBe(false);
  });

  it('parses Retry-After as delta-seconds or an HTTP date, and ignores junk', () => {
    expect(parseRetryAfter('7')).toBe(7000);
    expect(parseRetryAfter('0')).toBe(0);
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});
