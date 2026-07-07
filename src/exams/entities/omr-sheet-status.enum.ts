/**
 * OMR sheet processing lifecycle.
 *
 *   PENDING ──worker picks up job──▶ PROCESSING ──validation passes, graded──▶ COMPLETED
 *                                              └──validation fails / error──▶ FAILED
 */
export enum OmrSheetStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}
