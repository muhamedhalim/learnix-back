const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 60 * 60_000;
const MAX_EXPONENT = 7;

/**
 * Retry delay for a failed background attempt: 30 s doubling per attempt (the exponent stops
 * growing at 7, i.e. 64 min worth of doubling) and never more than 1 hour. Shared by the finance
 * reconciliation retries, the payment outbox and certificate auto-issuance retries so they keep
 * one schedule.
 */
export function exponentialRetryDelayMs(attempts: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempts, MAX_EXPONENT));
}
