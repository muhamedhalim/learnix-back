import { APP_TIMEZONE } from '../gamification.constants';

/** Local (app-timezone) calendar date string `YYYY-MM-DD` for an instant. */
export function appDateString(date: Date): string {
  // en-CA formats as YYYY-MM-DD; timeZone anchors the calendar day correctly.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Parse a `YYYY-MM-DD` string into a UTC-midnight epoch (calendar-day anchor). */
function toUtcMidnight(dateStr: string): number {
  const parts = dateStr.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return Date.UTC(year, month - 1, day);
}

/** Whole-day difference between two `YYYY-MM-DD` strings (b - a). */
export function dayDiff(a: string, b: string): number {
  return Math.round((toUtcMidnight(b) - toUtcMidnight(a)) / 86_400_000);
}

/** The calendar day before a `YYYY-MM-DD` string, as `YYYY-MM-DD`. */
export function previousDay(dateStr: string): string {
  const prev = new Date(toUtcMidnight(dateStr) - 86_400_000);
  const y = prev.getUTCFullYear();
  const m = String(prev.getUTCMonth() + 1).padStart(2, '0');
  const d = String(prev.getUTCDate()).padStart(2, '0');
  return `${String(y)}-${m}-${d}`;
}

export type StreakTransition = 'started' | 'extended' | 'reset' | 'same_day';

/**
 * Compute the next streak from the last active date and today's date. Pure:
 *  - no previous day  → started (1)
 *  - yesterday        → extended (+1)
 *  - today            → same_day (unchanged)
 *  - older            → reset (1)
 */
export function nextStreak(
  currentStreak: number,
  lastActiveDate: string | null,
  today: string,
): { streak: number; transition: StreakTransition } {
  if (lastActiveDate === null) return { streak: 1, transition: 'started' };
  const diff = dayDiff(lastActiveDate, today);
  if (diff === 0) return { streak: currentStreak, transition: 'same_day' };
  if (diff === 1) return { streak: currentStreak + 1, transition: 'extended' };
  return { streak: 1, transition: 'reset' };
}
