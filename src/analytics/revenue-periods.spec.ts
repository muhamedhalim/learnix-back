import { getUtcRevenuePeriodBoundaries } from './revenue-periods';

describe('getUtcRevenuePeriodBoundaries', () => {
  it.each([
    ['2026-01-15T10:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    ['2026-04-15T10:00:00.000Z', '2026-04-01T00:00:00.000Z'],
    ['2026-07-15T10:00:00.000Z', '2026-07-01T00:00:00.000Z'],
    ['2026-10-15T10:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    ['2026-11-15T10:00:00.000Z', '2026-10-01T00:00:00.000Z'],
  ])('calculates the calendar-quarter start for %s', (now, expected) => {
    expect(getUtcRevenuePeriodBoundaries(new Date(now)).startQuarter.toISOString()).toBe(expected);
  });

  it('keeps previous month exclusive on the first day of a month', () => {
    const boundaries = getUtcRevenuePeriodBoundaries(new Date('2026-08-01T00:00:00.000Z'));

    expect(boundaries.startLastMonth.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(boundaries.startMonth.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });
});
