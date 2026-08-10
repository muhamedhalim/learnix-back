/**
 * The application's civil timezone, and the primitives for converting between
 * a wall-clock reading in it and an absolute instant.
 *
 * Learnix is an Egyptian platform: a "week" or a "month" is what a parent in
 * Cairo would call one, not a UTC window. Egypt reintroduced DST in 2023, so
 * the offset is *not* a constant — every conversion below resolves the offset
 * that was actually in force at the instant concerned rather than assuming
 * +02:00. Getting this wrong shifts a report period by an hour twice a year,
 * which silently moves activity between two adjacent reports.
 *
 * No date library is a dependency of this project, so the conversions are built
 * on `Intl.DateTimeFormat`, which ships the IANA database with the runtime.
 */

/** IANA zone used for every civil-calendar boundary. */
export const DEFAULT_APP_TIME_ZONE = 'Africa/Cairo';

/**
 * Resolve the configured zone, falling back to Cairo.
 *
 * Read from `process.env` rather than `ConfigService` because this is consulted
 * from module-level constants evaluated before Nest's DI container exists — the
 * same reasoning as `areQueuesEnabled()` in `queues.constants.ts`.
 */
export function resolveAppTimeZone(): string {
  const configured = process.env['APP_TIMEZONE']?.trim();
  if (configured === undefined || configured === '') return DEFAULT_APP_TIME_ZONE;

  // A bad zone would otherwise throw from deep inside a worker on the first
  // report of the month. Fail loudly here instead, at boot.
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: configured }).format(new Date());
    return configured;
  } catch {
    throw new Error(
      `APP_TIMEZONE="${configured}" is not a valid IANA time zone identifier ` +
        `(expected something like "${DEFAULT_APP_TIME_ZONE}")`,
    );
  }
}

/** A wall-clock reading, as a human in the zone would state it. */
export interface ZonedDateParts {
  year: number;
  /** 1–12, *not* the 0-based month `Date` uses. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const PARTS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = PARTS_FORMATTER_CACHE.get(timeZone);
  if (cached !== undefined) return cached;

  // `hourCycle: 'h23'` prevents midnight formatting as "24" under some locales,
  // which would otherwise parse into the wrong day.
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  PARTS_FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

/** What the clock in `timeZone` reads at the given instant. */
export function utcToZonedParts(instant: Date, timeZone: string): ZonedDateParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? 0 : Number(found.value);
  };

  return {
    year: lookup('year'),
    month: lookup('month'),
    day: lookup('day'),
    hour: lookup('hour'),
    minute: lookup('minute'),
    second: lookup('second'),
    millisecond: instant.getUTCMilliseconds(),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (east positive). */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = utcToZonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  return asIfUtc - instant.getTime();
}

/**
 * The instant at which the clock in `timeZone` reads the given wall-clock time.
 *
 * The offset depends on the instant, and the instant is what we are solving
 * for — so we guess using the offset at the naive UTC reading, then re-resolve
 * once at the candidate instant. The second pass is what makes DST-transition
 * days correct: without it, a boundary falling on the far side of a clock
 * change lands an hour out.
 *
 * Wall-clock times that do not exist (inside a spring-forward gap) resolve to
 * the instant the clock jumps to; ambiguous ones (inside an autumn-back
 * overlap) resolve to the first occurrence. Neither case can affect a period
 * boundary here, which is always local midnight — no zone shifts its clock
 * across midnight.
 */
export function zonedPartsToUtc(parts: ZonedDateParts, timeZone: string): Date {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );

  const firstGuess = naive - timeZoneOffsetMs(new Date(naive), timeZone);
  const refinedOffset = timeZoneOffsetMs(new Date(firstGuess), timeZone);
  return new Date(naive - refinedOffset);
}

/** Local calendar date as `YYYY-MM-DD`. */
export function zonedDateString(instant: Date, timeZone: string): string {
  const { year, month, day } = utcToZonedParts(instant, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Local midnight (00:00:00.000) starting the calendar day `instant` falls in. */
export function startOfZonedDay(instant: Date, timeZone: string): Date {
  const { year, month, day } = utcToZonedParts(instant, timeZone);
  return zonedPartsToUtc(
    { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 },
    timeZone,
  );
}
