/**
 * Exam attempt state machine.
 *
 * Transitions:
 *   IN_PROGRESS ──submit──▶ SUBMITTED ──(has manual answers)──▶ GRADING ──▶ GRADED
 *              └──submit (all auto)────────────────────────────────────────▶ GRADED
 *   IN_PROGRESS ──deadline passed──▶ (auto-submit) ──▶ SUBMITTED/GRADING/GRADED
 *   IN_PROGRESS ──abandoned/expired──▶ EXPIRED
 *   * ──admin void──▶ VOID
 *
 * The server is the sole authority for these transitions.
 */
export enum AttemptState {
  IN_PROGRESS = 'in_progress',
  SUBMITTED = 'submitted',
  GRADING = 'grading',
  GRADED = 'graded',
  EXPIRED = 'expired',
  VOID = 'void',
}
