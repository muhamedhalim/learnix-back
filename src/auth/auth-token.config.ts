import { durationToMilliseconds } from '../common/utils/duration.util';

export const DEFAULT_ACCESS_TOKEN_TTL = '15m';
export const MAX_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function capAccessTokenTtl(configured: string | undefined): string {
  const ttl = configured ?? DEFAULT_ACCESS_TOKEN_TTL;
  const ttlMs = durationToMilliseconds(ttl);
  if (ttlMs === null || ttlMs <= 0 || ttlMs > MAX_ACCESS_TOKEN_TTL_MS) {
    return DEFAULT_ACCESS_TOKEN_TTL;
  }
  return ttl;
}

export function accessTokenTtlMilliseconds(configured: string | undefined): number {
  return durationToMilliseconds(capAccessTokenTtl(configured)) ?? MAX_ACCESS_TOKEN_TTL_MS;
}

export function refreshTokenTtlMilliseconds(configured: string | undefined): number {
  const parsed = durationToMilliseconds(configured ?? '7d');
  return parsed !== null && parsed > 0 ? parsed : DEFAULT_REFRESH_TOKEN_TTL_MS;
}
