/**
 * Auditable actions recorded against a code (or batch of codes). Every
 * lifecycle transition and admin operation writes an immutable audit row, which
 * together form the per-batch activity timeline.
 */
export enum AttendanceCodeAuditAction {
  // Per-code / bulk actions
  GENERATED = 'generated',
  REDEEMED = 'redeemed',
  REVOKED = 'revoked',
  ENABLED = 'enabled',
  DISABLED = 'disabled',
  DELETED = 'deleted',
  EXPIRED = 'expired',
  EXPORTED = 'exported',

  // Batch lifecycle (timeline)
  BATCH_CREATED = 'batch_created',
  BATCH_STARTED = 'batch_started',
  BATCH_FAILED = 'batch_failed',

  // Export lifecycle (timeline)
  EXPORT_REQUESTED = 'export_requested',
  DOWNLOADED = 'downloaded',
}
