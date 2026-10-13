import type { QueueOptions } from 'bullmq';

import { resolveRedisUrl } from '../common/utils/redis-connection.util';
import { bullMqPrefix } from '../common/utils/redis-namespace.util';

type EnvReader = (key: string) => string | undefined;

/**
 * Options for a BullMQ `Queue` opened OUTSIDE the Nest queue module (health checks, admin queue
 * actions, metrics, maintenance scripts). Must carry the same `prefix` as `QueuesModule`: with a
 * Redis namespace (staging: `learnix:staging`) a queue opened with BullMQ's default `bull` prefix is
 * a different, empty queue, so counts read zero and admin actions silently do nothing.
 *
 * Null when Redis is not configured.
 */
export function standaloneQueueOptions(get: EnvReader): QueueOptions | null {
  const url = resolveRedisUrl(get);
  if (!url) return null;
  const prefix = bullMqPrefix(get);
  return { connection: { url }, ...(prefix !== undefined ? { prefix } : {}) };
}
