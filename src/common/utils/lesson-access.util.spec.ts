import { computeAccessExpiresAt } from './lesson-access.util';

describe('computeAccessExpiresAt', () => {
  it('expires at the start of day 8 for a 7-day grant made early in the day', () => {
    const grantedAt = new Date('2024-07-01T00:05:00.000Z');
    const expiresAt = computeAccessExpiresAt(grantedAt, 7);
    expect(expiresAt.toISOString()).toBe('2024-07-08T00:00:00.000Z');
  });

  it('expires at the start of day 8 for a 7-day grant made late in the day (the reported bug)', () => {
    // Purchased at 23:59 on 1 Jul — must still expire at the start of 8 Jul,
    // NOT 23:59 on 8 Jul (which is what naive `setDate(+7)` would produce).
    const grantedAt = new Date('2024-07-01T23:59:59.999Z');
    const expiresAt = computeAccessExpiresAt(grantedAt, 7);
    expect(expiresAt.toISOString()).toBe('2024-07-08T00:00:00.000Z');
  });

  it('grants exactly 1 day when accessDays=1: available only on the grant day, expires start of next day', () => {
    const grantedAt = new Date('2024-07-01T14:32:07.000Z');
    const expiresAt = computeAccessExpiresAt(grantedAt, 1);
    expect(expiresAt.toISOString()).toBe('2024-07-02T00:00:00.000Z');
  });

  it('correctly rolls over a month boundary', () => {
    const grantedAt = new Date('2024-01-28T10:00:00.000Z');
    const expiresAt = computeAccessExpiresAt(grantedAt, 7);
    expect(expiresAt.toISOString()).toBe('2024-02-04T00:00:00.000Z');
  });

  it('correctly rolls over a year boundary', () => {
    const grantedAt = new Date('2024-12-28T10:00:00.000Z');
    const expiresAt = computeAccessExpiresAt(grantedAt, 7);
    expect(expiresAt.toISOString()).toBe('2025-01-04T00:00:00.000Z');
  });

  it('the student cannot access on day 8: "now" one millisecond into the expiry day is not before expiresAt', () => {
    const grantedAt = new Date('2024-07-01T09:00:00.000Z');
    const expiresAt = computeAccessExpiresAt(grantedAt, 7);
    const startOfDay8 = new Date('2024-07-08T00:00:00.001Z');
    expect(startOfDay8.getTime()).toBeGreaterThanOrEqual(expiresAt.getTime());
  });

  it('the student CAN access up through the last millisecond of day 7', () => {
    const grantedAt = new Date('2024-07-01T09:00:00.000Z');
    const expiresAt = computeAccessExpiresAt(grantedAt, 7);
    const endOfDay7 = new Date('2024-07-07T23:59:59.999Z');
    expect(endOfDay7.getTime()).toBeLessThan(expiresAt.getTime());
  });
});
