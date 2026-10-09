/**
 * Allow-list classifier for transient infrastructure failures (database or
 * network unavailable). Anything not matched is NOT infrastructure: callers must
 * keep the status that path returned before (credential/data/unknown errors must
 * never be turned into a 503, which would make a status oracle of the guards).
 */

const NODE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

// SQLSTATE: class 08 connection exception, class 53 insufficient resources,
// 57P01-57P03 admin shutdown / crash shutdown / cannot connect now,
// 57014 query_canceled (statement timeout).
const PG_EXACT_CODES = new Set(['57P01', '57P02', '57P03', '57014']);
const PG_CODE_CLASSES = ['08', '53'];

// pg / pg-pool messages (no stable code is set on these).
const INFRA_MESSAGES = [
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
];

function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function matches(value: unknown): boolean {
  const code = codeOf(value);
  if (code !== undefined) {
    if (NODE_NETWORK_CODES.has(code) || PG_EXACT_CODES.has(code)) return true;
    if (PG_CODE_CLASSES.some((prefix) => code.length === 5 && code.startsWith(prefix))) return true;
  }
  if (value instanceof Error) {
    return INFRA_MESSAGES.some((message) => value.message.includes(message));
  }
  return false;
}

export function isInfrastructureError(error: unknown): boolean {
  if (matches(error)) return true;
  // TypeORM wraps driver failures: QueryFailedError carries `driverError`.
  if (typeof error === 'object' && error !== null) {
    const { driverError, cause } = error as { driverError?: unknown; cause?: unknown };
    return matches(driverError) || matches(cause);
  }
  return false;
}
