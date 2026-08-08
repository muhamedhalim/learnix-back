import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * The canonical per-request correlation context.
 *
 * ONE id per request, minted (or accepted from an upstream proxy) exactly once
 * by `RequestPerformanceMiddleware`, and read from here by every other
 * observability surface: the access log, the RFC 7807 error body, the
 * `X-Request-Id` response header, the database timing log, and the Sentry
 * scope.
 *
 * Before this, three different identifiers existed for the same request — a
 * UUID on the response header, a *different* UUID in the error body, and a
 * numeric counter in query logs — so a request id quoted by a user could not be
 * joined to any log line. `requestId` is therefore a string now, not the old
 * monotonic number; the number identified nothing outside this process.
 */
export interface RequestPerformanceContext {
  /** Canonical correlation id for this request. Stable for its whole lifetime. */
  requestId: string;
  queryCount: number;
  dbDurationMs: number;
}

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Accepted shape for an inbound `X-Request-Id`. Deliberately narrow: the value
 * is echoed into response headers, log lines and error bodies, so it must not
 * be able to carry whitespace, control characters, CR/LF (header/log
 * injection), or unbounded length.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export const requestPerformanceStorage = new AsyncLocalStorage<RequestPerformanceContext>();

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/**
 * Honour a well-formed inbound id (from a load balancer / gateway / the calling
 * client) so a request can be traced across systems; otherwise mint one.
 * A malformed inbound value is replaced rather than rejected — an unusable
 * correlation header must never turn into a failed request.
 */
export function resolveRequestId(inbound: string | string[] | undefined): string {
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  return isValidRequestId(candidate) ? candidate : randomUUID();
}

export function createRequestPerformanceContext(requestId: string): RequestPerformanceContext {
  return {
    requestId,
    queryCount: 0,
    dbDurationMs: 0,
  };
}

/** The active request's canonical id, or `undefined` outside a request. */
export function getCurrentRequestId(): string | undefined {
  return requestPerformanceStorage.getStore()?.requestId;
}

export function recordQueryForCurrentRequest(durationMs: number): void {
  const context = requestPerformanceStorage.getStore();
  if (!context) return;

  context.queryCount++;
  context.dbDurationMs += durationMs;
}
