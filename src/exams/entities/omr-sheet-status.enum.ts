/**
 * OMR sheet processing lifecycle.
 *
 *   PENDING ──worker picks up job──▶ PROCESSING
 *     (generated, unscanned: image_key IS NULL — OR uploaded & queued)
 *
 *   PROCESSING ──recognition runs──┬──all confident──────────▶ READY
 *                                  ├──some flagged────────────▶ REVIEW_REQUIRED
 *                                  └──unrecoverable (bad image/
 *                                     no markers/wrong template)▶ FAILED
 *
 *   READY / REVIEW_REQUIRED ──teacher resolves every flagged
 *                              question, then confirms────────▶ CONFIRMED
 *
 *   CONFIRMED ──attempt created + graded synchronously────────▶ COMPLETED
 *
 * `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED` keep their original meaning
 * from the pre-recognition pipeline (`COMPLETED` = final graded state, same
 * as before) — only `REVIEW_REQUIRED`, `READY`, `CONFIRMED` are new.
 */
export enum OmrSheetStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  REVIEW_REQUIRED = 'review_required',
  READY = 'ready',
  CONFIRMED = 'confirmed',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/** Statuses that block a new active sheet for the same (exam, student). */
export const OMR_SHEET_TERMINAL_STATUSES = [
  OmrSheetStatus.COMPLETED,
  OmrSheetStatus.FAILED,
] as const;

/** Re-scan / reprocess are only safe before the sheet's answers are locked in. */
export const OMR_SHEET_MUTABLE_STATUSES = [
  OmrSheetStatus.PENDING,
  OmrSheetStatus.PROCESSING,
  OmrSheetStatus.READY,
  OmrSheetStatus.REVIEW_REQUIRED,
  OmrSheetStatus.FAILED,
] as const;
