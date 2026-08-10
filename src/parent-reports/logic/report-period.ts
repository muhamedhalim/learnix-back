import {
  utcToZonedParts,
  zonedDateString,
  zonedPartsToUtc,
  type ZonedDateParts,
} from '../../common/utils/app-timezone.util';
import { ParentReportType } from '../entities/parent-report-type.enum';

/**
 * Deterministic reporting periods.
 *
 * Every function here is pure: given the same `now` and zone it returns the
 * same boundaries, forever. That is the property the whole idempotency story
 * rests on — the sweep runs repeatedly (daily, and again after any restart),
 * and each run must resolve to the *same* period key so the unique constraint
 * on `parent_reports` can collapse the duplicates.
 *
 * Two deliberate choices:
 *
 *  - A period is always a *completed* one. A weekly report sent on Monday
 *    covers last Monday–Sunday, never the week in progress. Reporting on a
 *    partial period would make the same key mean different data at different
 *    times, which is exactly what idempotency must rule out.
 *
 *  - `endsAt` is **exclusive**. Half-open `[start, end)` intervals tile the
 *    calendar with no gaps and no overlaps, so an event at local midnight
 *    belongs to exactly one period. An inclusive end would either double-count
 *    it or, with the usual `23:59:59.999` fudge, silently drop anything in the
 *    final millisecond.
 */

/** A resolved, closed reporting window. */
export interface ReportPeriod {
  type: ParentReportType;
  /** Stable, collision-free identity — `w2026-08-03` / `m2026-07`. */
  key: string;
  /** Inclusive lower bound, as an absolute instant. */
  startsAt: Date;
  /** **Exclusive** upper bound, as an absolute instant. */
  endsAt: Date;
  /** First local calendar day in the period, `YYYY-MM-DD`. */
  startDate: string;
  /** Last local calendar day in the period, `YYYY-MM-DD` (i.e. `endsAt` minus a day). */
  endDate: string;
  timeZone: string;
}

const MS_PER_DAY = 86_400_000;

/** Civil date arithmetic done on a UTC day counter, immune to DST. */
function addCalendarDays(
  parts: Pick<ZonedDateParts, 'year' | 'month' | 'day'>,
  days: number,
): Pick<ZonedDateParts, 'year' | 'month' | 'day'> {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * MS_PER_DAY);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
function isoWeekday(parts: Pick<ZonedDateParts, 'year' | 'month' | 'day'>): number {
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function localMidnight(
  parts: Pick<ZonedDateParts, 'year' | 'month' | 'day'>,
  timeZone: string,
): Date {
  return zonedPartsToUtc({ ...parts, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone);
}

function asDateString(parts: Pick<ZonedDateParts, 'year' | 'month' | 'day'>): string {
  return (
    `${String(parts.year).padStart(4, '0')}-` +
    `${String(parts.month).padStart(2, '0')}-` +
    `${String(parts.day).padStart(2, '0')}`
  );
}

/**
 * The last complete Monday–Sunday week before `now`.
 *
 * Week boundaries are ISO (Monday-start) rather than the Saturday-start week
 * used socially in Egypt, because ISO is what the rest of the codebase already
 * assumes (`LB_KEYS.weeklyXp` keys leaderboards by ISO week) and mixing two
 * week definitions in one product is worse than either choice alone.
 */
export function resolveWeeklyPeriod(now: Date, timeZone: string): ReportPeriod {
  const today = utcToZonedParts(now, timeZone);
  const startOfThisWeek = addCalendarDays(today, -(isoWeekday(today) - 1));
  const startOfLastWeek = addCalendarDays(startOfThisWeek, -7);
  const lastDay = addCalendarDays(startOfThisWeek, -1);

  return {
    type: ParentReportType.WEEKLY,
    key: `w${asDateString(startOfLastWeek)}`,
    startsAt: localMidnight(startOfLastWeek, timeZone),
    endsAt: localMidnight(startOfThisWeek, timeZone),
    startDate: asDateString(startOfLastWeek),
    endDate: asDateString(lastDay),
    timeZone,
  };
}

/**
 * The last complete calendar month before `now`.
 *
 * Calendar month, explicitly — not "the last 30 days". A parent reading
 * "August report" expects 1–31 August, and a rolling window would also break
 * the deterministic key: every day would produce a different period.
 */
export function resolveMonthlyPeriod(now: Date, timeZone: string): ReportPeriod {
  const today = utcToZonedParts(now, timeZone);
  const startOfThisMonth = { year: today.year, month: today.month, day: 1 };
  const startOfLastMonth =
    today.month === 1
      ? { year: today.year - 1, month: 12, day: 1 }
      : { year: today.year, month: today.month - 1, day: 1 };
  const lastDay = addCalendarDays(startOfThisMonth, -1);

  return {
    type: ParentReportType.MONTHLY,
    key: `m${String(startOfLastMonth.year).padStart(4, '0')}-${String(startOfLastMonth.month).padStart(2, '0')}`,
    startsAt: localMidnight(startOfLastMonth, timeZone),
    endsAt: localMidnight(startOfThisMonth, timeZone),
    startDate: asDateString(startOfLastMonth),
    endDate: asDateString(lastDay),
    timeZone,
  };
}

export function resolveReportPeriod(
  type: ParentReportType,
  now: Date,
  timeZone: string,
): ReportPeriod {
  return type === ParentReportType.WEEKLY
    ? resolveWeeklyPeriod(now, timeZone)
    : resolveMonthlyPeriod(now, timeZone);
}

/**
 * Whether a period is still fresh enough to send.
 *
 * The sweep runs daily rather than only on the nominal day, so a worker outage
 * on the 1st of the month self-heals on the 2nd instead of losing the month
 * entirely. The window is what stops that same daily rerun from being either a
 * nuisance or a surprise: past it, the period is history and no report is
 * generated. It also bounds what a guardian sees after switching the toggle
 * on — they get at most the period that just ended, never an archive.
 */
export function isWithinCatchUpWindow(period: ReportPeriod, now: Date, days: number): boolean {
  const elapsed = now.getTime() - period.endsAt.getTime();
  return elapsed >= 0 && elapsed < days * MS_PER_DAY;
}

/**
 * Re-hydrate a period from its persisted columns.
 *
 * Note there is deliberately no `formatPeriodLabel` here: how a period reads to
 * a parent, in which language, is presentation and lives in
 * `parent-template.catalog.ts` with every other string a guardian can see. This
 * module knows only about instants.
 */
export function periodFromRecord(record: {
  report_type: ParentReportType;
  period_key: string;
  period_start: Date;
  period_end: Date;
  time_zone: string;
}): ReportPeriod {
  const startDate = zonedDateString(record.period_start, record.time_zone);
  const endDate = zonedDateString(
    new Date(record.period_end.getTime() - MS_PER_DAY),
    record.time_zone,
  );

  return {
    type: record.report_type,
    key: record.period_key,
    startsAt: record.period_start,
    endsAt: record.period_end,
    startDate,
    endDate,
    timeZone: record.time_zone,
  };
}
