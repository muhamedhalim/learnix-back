import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import Redis from 'ioredis';

import { resolveRedisUrl } from '../../common/utils/redis-connection.util';
import type { HealthIndicator } from '../health-indicator.interface';
import { errorCode, sanitiseMessage } from '../health-sanitizer.util';
import { withHealthTimeout } from '../health-timeout.util';
import type { HealthComponentResult } from '../health.types';
import { componentResult, statusForLatency } from './indicator-result.util';

function parseInfo(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of input.split('\n')) {
    if (line.startsWith('#') || !line.includes(':')) continue;
    const separator = line.indexOf(':');
    result[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return result;
}

@Injectable()
export class RedisHealthIndicator implements HealthIndicator {
  public readonly id = 'redis';

  constructor(private readonly config: ConfigService) {}

  public async check(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    const redisUrl = resolveRedisUrl((key) => this.config.get<string>(key));
    const production = this.config.get<string>('NODE_ENV') === 'production';
    if (!redisUrl) {
      return componentResult({
        id: this.id,
        name: 'Redis',
        category: 'cache',
        status: production ? 'misconfigured' : 'warning',
        startedAt,
        message:
          'Redis is not configured; cache, rate limiting, and queues use development fallbacks.',
        metadata: { configured: false },
        errorCode: 'REDIS_NOT_CONFIGURED',
        recommendation: 'Configure REDIS_URL or REDIS_HOST for shared cache and queues.',
        critical: production,
      });
    }

    const client = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 3_000,
      commandTimeout: 4_000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    try {
      await withHealthTimeout(this.id, client.connect(), 4_000);
      const pingStarted = Date.now();
      await withHealthTimeout(this.id, client.ping(), 3_000);
      const pingLatencyMs = Date.now() - pingStarted;
      const [memoryRaw, statsRaw, clientsRaw, serverRaw] = await withHealthTimeout(
        this.id,
        Promise.all([
          client.info('memory'),
          client.info('stats'),
          client.info('clients'),
          client.info('server'),
        ]),
        4_000,
      );
      const info = {
        ...parseInfo(memoryRaw),
        ...parseInfo(statsRaw),
        ...parseInfo(clientsRaw),
        ...parseInfo(serverRaw),
      };
      const usedMemory = Number(info['used_memory'] ?? 0);
      const maxMemory = Number(info['maxmemory'] ?? 0);
      const memoryUsagePercent = maxMemory > 0 ? (usedMemory / maxMemory) * 100 : null;
      const hits = Number(info['keyspace_hits'] ?? 0);
      const misses = Number(info['keyspace_misses'] ?? 0);
      const hitRate = hits + misses === 0 ? null : (hits / (hits + misses)) * 100;
      let status = statusForLatency(pingLatencyMs, 50, 200);
      if (memoryUsagePercent !== null && memoryUsagePercent >= 90) {
        status = 'degraded';
      } else if (memoryUsagePercent !== null && memoryUsagePercent >= 75) {
        status = 'warning';
      }

      return {
        ...componentResult({
          id: this.id,
          name: 'Redis',
          category: 'cache',
          status,
          startedAt,
          message:
            status === 'healthy'
              ? 'Redis responded and memory pressure is within safe thresholds.'
              : 'Redis latency or memory pressure is approaching an unsafe threshold.',
          metadata: {
            configured: true,
            connected: true,
            pingLatencyMs,
            usedMemoryBytes: usedMemory,
            maxMemoryBytes: maxMemory || null,
            memoryUsagePercent:
              memoryUsagePercent === null ? null : Math.round(memoryUsagePercent * 100) / 100,
            connectedClients: Number(info['connected_clients'] ?? 0),
            cacheHits: hits,
            cacheMisses: misses,
            cacheHitRatePercent: hitRate === null ? null : Math.round(hitRate * 100) / 100,
            evictedKeys: Number(info['evicted_keys'] ?? 0),
            expiredKeys: Number(info['expired_keys'] ?? 0),
            uptimeSeconds: Number(info['uptime_in_seconds'] ?? 0),
          },
          warnings: [
            ...(maxMemory === 0
              ? ['Redis maxmemory is unlimited; eviction protection depends on host memory.']
              : []),
            ...(Number(info['evicted_keys'] ?? 0) > 0
              ? ['Redis has evicted keys since startup.']
              : []),
          ],
          recommendation:
            status === 'healthy'
              ? null
              : 'Review Redis memory policy, host capacity, client count, and network latency.',
          critical: true,
        }),
        latencyMs: pingLatencyMs,
      };
    } catch (error) {
      return componentResult({
        id: this.id,
        name: 'Redis',
        category: 'cache',
        status: 'down',
        startedAt,
        message: sanitiseMessage(error),
        metadata: { configured: true, connected: false },
        errorCode: errorCode(error, 'REDIS_UNAVAILABLE'),
        recommendation:
          'Verify Redis availability, TLS/URL settings, credentials, and network access.',
        critical: true,
      });
    } finally {
      client.disconnect();
    }
  }
}
