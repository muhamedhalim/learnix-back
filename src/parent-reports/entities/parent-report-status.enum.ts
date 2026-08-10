/**
 * Lifecycle of one generated report.
 *
 * `GENERATED` and `DISPATCHED` are separate states on purpose: aggregation and
 * hand-off to the notification queue are distinct failures with distinct fixes.
 * A row stuck at `GENERATED` means Redis refused the job; a row at `DISPATCHED`
 * means the report engine's work is finished and any further question about
 * whether a parent actually received it is answered by `parent_messages`, not
 * here. The report engine deliberately does not track per-channel delivery —
 * that ledger already exists and duplicating it would create two disagreeing
 * sources of truth.
 */
export enum ParentReportStatus {
  /** Row claimed, aggregation not yet finished. */
  PENDING = 'pending',
  /** Payload computed and stored. */
  GENERATED = 'generated',
  /** Handed to the parent-notification queue. */
  DISPATCHED = 'dispatched',
  /** Nothing worth sending (no activity in the period). Terminal, not an error. */
  SKIPPED = 'skipped',
  /** Aggregation raised after retries were exhausted. */
  FAILED = 'failed',
}
