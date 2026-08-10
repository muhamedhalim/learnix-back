import { ParentEventType } from '../../common/events/parent-event-type.enum';

/**
 * The kinds of periodic report Learnix generates.
 *
 * Deliberately a separate enum from `ParentEventType` even though the two
 * overlap: `ParentEventType` is the *notification* vocabulary (what a guardian
 * can be messaged about, and the key of their preference map), while this is
 * the *report engine* vocabulary (what the aggregator knows how to build). The
 * mapping between them is one function, below — nothing else couples them.
 *
 * The string values are persisted in `parent_reports.report_type`, so they are
 * part of the database contract.
 */
export enum ParentReportType {
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
}

/** Which guardian notification a report of this type is delivered as. */
export function reportEventType(type: ParentReportType): ParentEventType {
  return type === ParentReportType.WEEKLY
    ? ParentEventType.WEEKLY_REPORT
    : ParentEventType.MONTHLY_REPORT;
}

export const ALL_PARENT_REPORT_TYPES: readonly ParentReportType[] = Object.freeze([
  ParentReportType.WEEKLY,
  ParentReportType.MONTHLY,
]);
