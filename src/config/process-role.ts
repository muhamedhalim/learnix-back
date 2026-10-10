/**
 * Which kind of work this process performs.
 *
 *   all     (default) HTTP + BullMQ consumers + @Cron jobs: the historical single-process behaviour
 *   api     HTTP only; BullMQ consumers and @Cron jobs are off (queues still accept new jobs)
 *   worker  HTTP stays up (for health checks, not routed) and consumers + @Cron jobs run
 *
 * Read from `process.env` because it is consulted from static `@Module()` / `@Processor()`
 * metadata, evaluated before Nest's DI container exists (same constraint as feature-flags.ts).
 */
import type { EnvReader } from '../common/utils/redis-connection.util';
import { processEnvReader } from '../common/utils/redis-connection.util';

export const PROCESS_ROLES = ['all', 'api', 'worker'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

export function resolveProcessRole(get: EnvReader = processEnvReader()): ProcessRole {
  const raw = get('PROCESS_ROLE')?.trim().toLowerCase();
  if (raw === undefined || raw === '') return 'all';
  if ((PROCESS_ROLES as readonly string[]).includes(raw)) return raw as ProcessRole;
  throw new Error(`PROCESS_ROLE must be one of ${PROCESS_ROLES.join(', ')} (got "${raw}").`);
}

/** True when this process should consume queues and run scheduled jobs. */
export function runsBackgroundWork(get: EnvReader = processEnvReader()): boolean {
  return resolveProcessRole(get) !== 'api';
}
