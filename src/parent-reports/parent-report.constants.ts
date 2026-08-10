import { resolveAppTimeZone } from '../common/utils/app-timezone.util';

/**
 * Tuning for the periodic guardian report engine.
 *
 * The scheduling story in one paragraph: both sweeps run **daily**, and both
 * always resolve the *previous complete* period. On any day but the first of
 * the window that is a no-op, because the unique constraint on `parent_reports`
 * rejects the duplicate. What the daily cadence buys is self-healing — a worker
 * that was down at 08:00 on the 1st of the month still sends the month's
 * reports on the 2nd, instead of losing them until the next month. The
 * catch-up window then bounds how long that recovery stays open, so the daily
 * rerun cannot resurrect an ancient period weeks later.
 */

/** Zone whose calendar defines "week" and "month" for every report. */
export const REPORT_TIME_ZONE = resolveAppTimeZone();

/**
 * Cron for the weekly sweep — daily at 08:00 local.
 *
 * Morning rather than midnight: a report that arrives at 03:00 is a wasted
 * notification, and batching the platform's guardian messages into the small
 * hours also concentrates provider rate-limiting at the worst time to notice.
 */
export const WEEKLY_SWEEP_CRON = process.env['PARENT_REPORT_WEEKLY_CRON'] ?? '0 8 * * *';

/** Cron for the monthly sweep — daily at 08:30 local, offset to stagger load. */
export const MONTHLY_SWEEP_CRON = process.env['PARENT_REPORT_MONTHLY_CRON'] ?? '30 8 * * *';

/**
 * How long after a period closes it may still be reported on.
 *
 * Three days covers a long weekend of worker downtime while keeping the
 * guarantee a parent cares about: what arrives is always about the period that
 * just ended, never an archive dump.
 */
export const CATCH_UP_WINDOW_DAYS = Number.parseInt(
  process.env['PARENT_REPORT_CATCH_UP_DAYS'] ?? '3',
  10,
);

/**
 * Students per page of the sweep.
 *
 * Bounds peak memory to a page of uuids regardless of platform size, and keeps
 * each database round trip short enough not to hold a connection while the
 * queue absorbs the fan-out.
 */
export const SWEEP_PAGE_SIZE = Number.parseInt(
  process.env['PARENT_REPORT_SWEEP_PAGE_SIZE'] ?? '500',
  10,
);

/**
 * Whether a report with no activity at all is still sent.
 *
 * Default on: a guardian who asked for a weekly update is entitled to learn
 * that the week was empty — for most parents that is the single most
 * actionable thing the report can say. Operators who consider it noise can
 * turn it off without touching code.
 */
export const SEND_EMPTY_REPORTS = process.env['PARENT_REPORT_SEND_EMPTY'] !== 'false';
