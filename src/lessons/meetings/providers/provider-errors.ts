/**
 * A provider failure that is worth retrying: a timeout/network error, HTTP 429
 * or a 5xx. Deliberately NOT an `HttpException` — it is an internal signal for
 * the provisioning worker (BullMQ retries with backoff), never a response body.
 * Reconnect-required failures (401, `invalid_grant`) stay `UnauthorizedException`.
 */
export class RetryableProviderError extends Error {
  public constructor(
    message: string,
    /** Parsed `Retry-After`, when the provider sent one. */
    public readonly retryAfterMs: number | null = null,
    /** HTTP status that caused it; absent for timeouts/network errors. */
    public readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = 'RetryableProviderError';
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** `Retry-After` is either delta-seconds or an HTTP date; anything else is ignored. */
export function parseRetryAfter(
  header: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
