import {
  utcToZonedParts,
  zonedDateString,
  zonedPartsToUtc,
} from '../../common/utils/app-timezone.util';
import { ParentReportType } from '../entities/parent-report-type.enum';
import {
  isWithinCatchUpWindow,
  periodFromRecord,
  resolveMonthlyPeriod,
  resolveReportPeriod,
  resolveWeeklyPeriod,
} from './report-period';

const CAIRO = 'Africa/Cairo';
/** Rock-solid tzdata rules, used for the explicit DST assertions. */
const NEW_YORK = 'America/New_York';

/** The wall-clock reading in `zone` at an instant, as `YYYY-MM-DD HH:mm:ss`. */
function wallClock(instant: Date, zone: string): string {
  const p = utcToZonedParts(instant, zone);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ` +
    `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
  );
}

const HOUR_MS = 3_600_000;

describe('report-period', () => {
  describe('weekly', () => {
    // 2026-08-10 is a Monday, so the last complete week is 3–9 August.
    const mondayMorning = new Date('2026-08-10T09:00:00.000Z');

    it('covers the previous complete Monday–Sunday week', () => {
      const period = resolveWeeklyPeriod(mondayMorning, CAIRO);

      expect(period.type).toBe(ParentReportType.WEEKLY);
      expect(period.startDate).toBe('2026-08-03');
      expect(period.endDate).toBe('2026-08-09');
      expect(period.key).toBe('w2026-08-03');
    });

    it('never reports on the week in progress', () => {
      // Sunday of the current week — the week has not closed yet.
      const sunday = new Date('2026-08-16T20:00:00.000Z');
      const period = resolveWeeklyPeriod(sunday, CAIRO);

      expect(period.endDate).toBe('2026-08-09');
      expect(period.endsAt.getTime()).toBeLessThanOrEqual(sunday.getTime());
    });

    it('resolves the same period from any instant within the same local week', () => {
      const keys = [
        '2026-08-10T00:00:00.000Z', // Mon 03:00 Cairo
        '2026-08-12T13:37:00.000Z', // Wed
        '2026-08-16T18:30:00.000Z', // Sun 21:30 Cairo — still Sunday locally
      ].map((iso) => resolveWeeklyPeriod(new Date(iso), CAIRO).key);

      // Idempotency depends on this: a sweep that reruns must derive the same key.
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toBe('w2026-08-03');
    });

    it('assigns a week by the LOCAL calendar, not the UTC one', () => {
      // 2026-08-16T21:30Z is Sunday in UTC but already Monday 00:30 in Cairo
      // (UTC+3 in summer). A UTC-based implementation would put it in the
      // previous week and send a stale report; the local calendar is what a
      // parent in Cairo actually experiences.
      const lateSundayUtc = new Date('2026-08-16T21:30:00.000Z');

      expect(zonedDateString(lateSundayUtc, CAIRO)).toBe('2026-08-17');
      expect(resolveWeeklyPeriod(lateSundayUtc, CAIRO).key).toBe('w2026-08-10');
      // Same instant, read in UTC, would still be the earlier week.
      expect(resolveWeeklyPeriod(lateSundayUtc, 'UTC').key).toBe('w2026-08-03');
    });

    it('anchors both boundaries to local midnight, not UTC midnight', () => {
      const period = resolveWeeklyPeriod(mondayMorning, CAIRO);

      expect(wallClock(period.startsAt, CAIRO)).toBe('2026-08-03 00:00:00');
      expect(wallClock(period.endsAt, CAIRO)).toBe('2026-08-10 00:00:00');
    });

    it('spans exactly seven days', () => {
      const period = resolveWeeklyPeriod(mondayMorning, CAIRO);
      const hours = (period.endsAt.getTime() - period.startsAt.getTime()) / HOUR_MS;

      // 7×24 exactly — no DST transition falls inside this week.
      expect(hours).toBe(168);
    });

    it('rolls back across a year boundary', () => {
      // 2027-01-04 is a Monday; the previous week straddles New Year.
      const period = resolveWeeklyPeriod(new Date('2027-01-04T09:00:00.000Z'), CAIRO);

      expect(period.startDate).toBe('2026-12-28');
      expect(period.endDate).toBe('2027-01-03');
    });
  });

  describe('monthly', () => {
    it('covers the previous calendar month, not the last 30 days', () => {
      const period = resolveMonthlyPeriod(new Date('2026-08-01T09:00:00.000Z'), CAIRO);

      expect(period.type).toBe(ParentReportType.MONTHLY);
      expect(period.startDate).toBe('2026-07-01');
      expect(period.endDate).toBe('2026-07-31');
      expect(period.key).toBe('m2026-07');
    });

    it('uses full calendar months of differing length', () => {
      // February 2028 is a leap February — 29 days, not 28 and not 30.
      const period = resolveMonthlyPeriod(new Date('2028-03-01T09:00:00.000Z'), CAIRO);

      expect(period.startDate).toBe('2028-02-01');
      expect(period.endDate).toBe('2028-02-29');
    });

    it('rolls January back to the previous December', () => {
      const period = resolveMonthlyPeriod(new Date('2027-01-01T09:00:00.000Z'), CAIRO);

      expect(period.startDate).toBe('2026-12-01');
      expect(period.endDate).toBe('2026-12-31');
      expect(period.key).toBe('m2026-12');
    });

    it('resolves the same period from any instant within the month', () => {
      const keys = ['2026-08-01T00:30:00.000Z', '2026-08-19T12:00:00.000Z'].map(
        (iso) => resolveMonthlyPeriod(new Date(iso), CAIRO).key,
      );

      expect(new Set(keys).size).toBe(1);
    });

    it('anchors both boundaries to local midnight', () => {
      const period = resolveMonthlyPeriod(new Date('2026-08-01T09:00:00.000Z'), CAIRO);

      expect(wallClock(period.startsAt, CAIRO)).toBe('2026-07-01 00:00:00');
      expect(wallClock(period.endsAt, CAIRO)).toBe('2026-08-01 00:00:00');
    });
  });

  describe('daylight saving', () => {
    /**
     * The property that matters is that a boundary is local midnight *whatever
     * the offset was that day*. A naive "local midnight = UTC midnight − fixed
     * offset" implementation passes every test above and fails these two.
     */
    it('keeps boundaries at local midnight across a spring-forward month', () => {
      // US DST began 2026-03-08. March therefore contains 743 real hours.
      const period = resolveMonthlyPeriod(new Date('2026-04-01T12:00:00.000Z'), NEW_YORK);

      expect(period.startDate).toBe('2026-03-01');
      expect(wallClock(period.startsAt, NEW_YORK)).toBe('2026-03-01 00:00:00');
      expect(wallClock(period.endsAt, NEW_YORK)).toBe('2026-04-01 00:00:00');

      const hours = (period.endsAt.getTime() - period.startsAt.getTime()) / HOUR_MS;
      expect(hours).toBe(31 * 24 - 1);
    });

    it('keeps boundaries at local midnight across a fall-back month', () => {
      // US DST ended 2026-11-01. November therefore contains 721 real hours.
      const period = resolveMonthlyPeriod(new Date('2026-12-01T12:00:00.000Z'), NEW_YORK);

      expect(wallClock(period.startsAt, NEW_YORK)).toBe('2026-11-01 00:00:00');
      expect(wallClock(period.endsAt, NEW_YORK)).toBe('2026-12-01 00:00:00');

      const hours = (period.endsAt.getTime() - period.startsAt.getTime()) / HOUR_MS;
      expect(hours).toBe(30 * 24 + 1);
    });

    it('round-trips a local midnight through both conversions', () => {
      for (const dateString of ['2026-03-08', '2026-11-01', '2026-08-03', '2026-01-15']) {
        const [year, month, day] = dateString.split('-').map(Number) as [number, number, number];
        const instant = zonedPartsToUtc(
          { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 },
          NEW_YORK,
        );
        expect(zonedDateString(instant, NEW_YORK)).toBe(dateString);
        expect(wallClock(instant, NEW_YORK)).toBe(`${dateString} 00:00:00`);
      }
    });
  });

  describe('periods tile the calendar', () => {
    it('leaves no gap and no overlap between consecutive weeks', () => {
      const thisWeek = resolveWeeklyPeriod(new Date('2026-08-10T09:00:00.000Z'), CAIRO);
      const nextWeek = resolveWeeklyPeriod(new Date('2026-08-17T09:00:00.000Z'), CAIRO);

      // Half-open [start, end): one period's exclusive end IS the next's
      // inclusive start, so every instant belongs to exactly one period.
      expect(nextWeek.startsAt.getTime()).toBe(thisWeek.endsAt.getTime());
    });

    it('leaves no gap and no overlap between consecutive months', () => {
      const july = resolveMonthlyPeriod(new Date('2026-08-05T09:00:00.000Z'), CAIRO);
      const august = resolveMonthlyPeriod(new Date('2026-09-05T09:00:00.000Z'), CAIRO);

      expect(august.startsAt.getTime()).toBe(july.endsAt.getTime());
    });
  });

  describe('catch-up window', () => {
    const period = resolveWeeklyPeriod(new Date('2026-08-10T09:00:00.000Z'), CAIRO);

    it('is open on the day the period closes', () => {
      expect(isWithinCatchUpWindow(period, new Date('2026-08-10T06:00:00.000Z'), 3)).toBe(true);
    });

    it('stays open through the configured number of days', () => {
      // Period ends 2026-08-09T21:00Z; +2 days is still inside a 3-day window.
      expect(isWithinCatchUpWindow(period, new Date('2026-08-11T20:00:00.000Z'), 3)).toBe(true);
    });

    it('closes once the window has elapsed', () => {
      expect(isWithinCatchUpWindow(period, new Date('2026-08-20T09:00:00.000Z'), 3)).toBe(false);
    });

    it('rejects an instant before the period has closed', () => {
      // Guards against a clock skew or a misfired schedule reporting a live period.
      expect(isWithinCatchUpWindow(period, new Date('2026-08-05T09:00:00.000Z'), 3)).toBe(false);
    });
  });

  describe('resolveReportPeriod', () => {
    it('dispatches on report type', () => {
      const now = new Date('2026-08-10T09:00:00.000Z');

      expect(resolveReportPeriod(ParentReportType.WEEKLY, now, CAIRO).key).toBe('w2026-08-03');
      expect(resolveReportPeriod(ParentReportType.MONTHLY, now, CAIRO).key).toBe('m2026-07');
    });
  });

  describe('periodFromRecord', () => {
    it('reconstructs the local date range from stored columns', () => {
      const original = resolveMonthlyPeriod(new Date('2026-08-01T09:00:00.000Z'), CAIRO);

      const restored = periodFromRecord({
        report_type: original.type,
        period_key: original.key,
        period_start: original.startsAt,
        period_end: original.endsAt,
        time_zone: original.timeZone,
      });

      expect(restored.startDate).toBe(original.startDate);
      expect(restored.endDate).toBe(original.endDate);
      expect(restored.key).toBe(original.key);
    });
  });
});
