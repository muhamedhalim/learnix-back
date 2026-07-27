const SECRET_KEY =
  /(secret|password|passwd|token|authorization|cookie|credential|private.?key|api.?key|access.?key|connection.?string|dsn)/iu;
const PRIVATE_URL = /\b(?:postgres(?:ql)?|redis|rediss|amqp|mongodb(?:\+srv)?):\/\/[^\s]+/giu;
const PRIVATE_HTTP_URL =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^/\s]+\.internal)(?::\d+)?(?:\/[^\s]*)?/giu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;

export function sanitiseMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? 'Unknown error');
  return message
    .replaceAll(PRIVATE_URL, '[private-url]')
    .replaceAll(PRIVATE_HTTP_URL, '[private-url]')
    .replaceAll(BEARER, 'Bearer [redacted]')
    .replaceAll(JWT, '[redacted-token]')
    .replaceAll(EMAIL, (address) => {
      const [local = '', domain = ''] = address.split('@');
      return `${local.slice(0, 2)}***@${domain}`;
    })
    .slice(0, 500);
}

export function sanitiseMetadata(input: Record<string, unknown>): Record<string, unknown> {
  return sanitiseValue(input, 0) as Record<string, unknown>;
}

function sanitiseValue(value: unknown, depth: number): unknown {
  if (depth > 5) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitiseMessage(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitiseValue(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value);

  const safe: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    safe[key] = SECRET_KEY.test(key) ? '[redacted]' : sanitiseValue(nested, depth + 1);
  }
  return safe;
}

export function errorCode(error: unknown, fallback: string): string {
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const value =
    candidate.code ?? candidate.response?.status ?? candidate.status ?? candidate.name ?? fallback;
  return String(value)
    .replaceAll(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80);
}
