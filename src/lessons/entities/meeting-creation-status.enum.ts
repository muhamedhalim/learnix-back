/**
 * Per-appointment meeting provisioning state. `not_requested` is the resting
 * state of an individual slot the teacher has not yet pressed Generate on —
 * it is what makes "no automatic meeting creation" representable (AD-7).
 */
export enum MeetingCreationStatus {
  /** Group lesson slot — meetings never apply. */
  NOT_REQUIRED = 'not_required',
  /** Individual slot exists; the teacher has not pressed Generate. */
  NOT_REQUESTED = 'not_requested',
  /** Generate pressed; a provisioning job has been enqueued. */
  PENDING = 'pending',
  /** A worker has claimed the row and is calling the provider. */
  CREATING = 'creating',
  /** The meeting exists at the provider; `meeting_url` is populated. */
  READY = 'ready',
  /** The provider call failed; Retry is offered. */
  FAILED = 'failed',
}
