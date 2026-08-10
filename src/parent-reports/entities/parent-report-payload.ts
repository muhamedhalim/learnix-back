/**
 * The canonical report payload.
 *
 * This is the contract between the aggregator (which counts) and the template
 * catalogue (which words). It carries *numbers only* — no prose, no language,
 * no formatting. That separation is what lets one stored report be rendered in
 * Arabic for one guardian and English for another, and it is why the aggregator
 * has no business importing anything from `notifications/templates`.
 *
 * `version` is stored alongside the data so a future change to what the report
 * counts can be told apart from an older row rather than silently
 * misinterpreted by a newer renderer.
 */
export const PARENT_REPORT_PAYLOAD_VERSION = 1;

export interface ParentReportPayload {
  version: number;

  study: {
    /** Distinct lesson-viewing sessions opened in the period. */
    sessions: number;
    /** Distinct lessons touched in the period. */
    lessons: number;
    /** Time actually spent in lessons, rounded to whole minutes. */
    minutes: number;
    /** Lessons that crossed into "completed" *during* the period. */
    completed: number;
  };

  attendance: {
    present: number;
    absent: number;
    late: number;
    excused: number;
    total: number;
  };

  exams: {
    /** Attempts graded in the period. */
    graded: number;
    /** Mean percentage across those attempts, or null when none were graded. */
    averagePercent: number | null;
    passed: number;
    failed: number;
  };

  homework: {
    submitted: number;
    graded: number;
    /** Mean percentage across graded submissions, or null when none were. */
    averagePercent: number | null;
    late: number;
  };

  /**
   * Whether anything at all happened. Drives the "quiet period" wording rather
   * than suppressing the report: a parent who asked for a weekly update is
   * entitled to learn that the week was empty, which is often the single most
   * actionable thing a report can tell them.
   */
  hasActivity: boolean;
}

export function emptyReportPayload(): ParentReportPayload {
  return {
    version: PARENT_REPORT_PAYLOAD_VERSION,
    study: { sessions: 0, lessons: 0, minutes: 0, completed: 0 },
    attendance: { present: 0, absent: 0, late: 0, excused: 0, total: 0 },
    exams: { graded: 0, averagePercent: null, passed: 0, failed: 0 },
    homework: { submitted: 0, graded: 0, averagePercent: null, late: 0 },
    hasActivity: false,
  };
}
