/**
 * Generation lifecycle of a code batch. Generation runs in a BullMQ worker, so
 * a batch is created `PENDING`, flips to `PROCESSING` when the worker starts,
 * and ends `COMPLETED` or `FAILED`.
 */
export enum CodeBatchStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}
