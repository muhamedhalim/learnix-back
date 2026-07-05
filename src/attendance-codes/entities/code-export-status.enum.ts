/** Lifecycle of an asynchronous export job. */
export enum CodeExportStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}
