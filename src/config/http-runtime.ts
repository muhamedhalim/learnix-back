/**
 * Runtime knobs for running behind CloudFront + an ALB. All read from env so the same image
 * works anywhere, and every default preserves a safe, platform-neutral behaviour.
 */
import type { LogLevel } from '@nestjs/common';

import type { EnvReader } from '../common/utils/redis-connection.util';
import { processEnvReader } from '../common/utils/redis-connection.util';

/**
 * Number of trusted proxy hops in front of the app (Express `trust proxy`).
 * 1 = a single proxy (historic default). CloudFront + ALB = 2. Too low keys the rate limiter on
 * an edge/LB address; too high lets a client spoof X-Forwarded-For, so it is explicit and bounded.
 */
export function resolveTrustProxyHops(get: EnvReader = processEnvReader()): number {
  const raw = get('TRUST_PROXY_HOPS');
  if (raw === undefined || raw.trim() === '') return 1;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5.');
  }
  return hops;
}

export interface KeepAliveTimeouts {
  keepAliveTimeoutMs: number;
  headersTimeoutMs: number;
}

/**
 * Node must keep idle sockets open LONGER than the load balancer does, otherwise the LB reuses a
 * socket Node just closed and the client sees a 502. ALB idle timeout is 120 s, so the default is
 * 125 s; headersTimeout must exceed keepAliveTimeout.
 */
export function resolveKeepAliveTimeouts(get: EnvReader = processEnvReader()): KeepAliveTimeouts {
  const raw = get('HTTP_KEEP_ALIVE_TIMEOUT_MS');
  const keepAliveTimeoutMs = raw === undefined || raw.trim() === '' ? 125_000 : Number(raw);
  if (!Number.isInteger(keepAliveTimeoutMs) || keepAliveTimeoutMs < 1_000) {
    throw new Error('HTTP_KEEP_ALIVE_TIMEOUT_MS must be an integer of at least 1000.');
  }
  return { keepAliveTimeoutMs, headersTimeoutMs: keepAliveTimeoutMs + 5_000 };
}

export type LogFormat = 'text' | 'json';

/** `json` emits one JSON object per log line (CloudWatch Logs Insights friendly). Default `text`. */
export function resolveLogFormat(get: EnvReader = processEnvReader()): LogFormat {
  const raw = get('LOG_FORMAT')?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'text') return 'text';
  if (raw === 'json') return 'json';
  throw new Error('LOG_FORMAT must be "text" or "json".');
}

export function buildLoggerOptions(
  logLevels: LogLevel[],
  get: EnvReader = processEnvReader(),
): { logLevels: LogLevel[]; json: boolean; colors: boolean } {
  const json = resolveLogFormat(get) === 'json';
  return { logLevels, json, colors: !json };
}
