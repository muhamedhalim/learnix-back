import { Logger } from '@nestjs/common';

/**
 * Orderly shutdown for ECS/Fargate (SIGTERM, then SIGKILL after `stopTimeout`, 60 s in our task definitions).
 *
 *   1. `markDraining()`: readiness answers `not_ready`, so nothing new is routed here.
 *   2. Wait `SHUTDOWN_DELAY_MS` (default 0, 10 s on AWS) so the load balancer, which deregisters the target in
 *      parallel with the signal, stops sending requests before the listener closes.
 *   3. `app.close()`: the HTTP server stops accepting, in-flight requests finish, then the lifecycle hooks
 *      close the database pool, Redis clients and BullMQ workers.
 *   4. If that takes longer than `SHUTDOWN_TIMEOUT_MS` (default 40 s), exit non-zero rather than be killed
 *      mid-write by the SIGKILL that follows.
 *
 * Replaces `app.enableShutdownHooks()`, which closes immediately on the signal and cannot be delayed.
 */
const logger = new Logger('Shutdown');

let draining = false;

export function isDraining(): boolean {
  return draining;
}

export function markDraining(): void {
  draining = true;
}

/** Test helper: the flag is process-wide state. */
export function resetDrainingForTests(): void {
  draining = false;
}

function readMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface ShutdownTarget {
  close(): Promise<void>;
}

export interface ShutdownProcess {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  exit(code: number): void;
}

export function installGracefulShutdown(
  app: ShutdownTarget,
  options: { env?: NodeJS.ProcessEnv; proc?: ShutdownProcess } = {},
): void {
  const env = options.env ?? process.env;
  const proc: ShutdownProcess = options.proc ?? process;
  const delayMs = readMs(env['SHUTDOWN_DELAY_MS'], 0);
  const timeoutMs = readMs(env['SHUTDOWN_TIMEOUT_MS'], 40_000);

  let started = false;
  const shutdown = (signal: string): void => {
    if (started) return;
    started = true;
    markDraining();
    logger.log(JSON.stringify({ event: 'shutdown_started', signal, delay_ms: delayMs }));

    const hardStop = setTimeout(() => {
      logger.error(JSON.stringify({ event: 'shutdown_timeout', timeout_ms: timeoutMs }));
      proc.exit(1);
    }, delayMs + timeoutMs);
    hardStop.unref();

    void (async (): Promise<void> => {
      try {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        await app.close();
        clearTimeout(hardStop);
        logger.log(JSON.stringify({ event: 'shutdown_complete' }));
        proc.exit(0);
      } catch (error) {
        clearTimeout(hardStop);
        logger.error(
          JSON.stringify({
            event: 'shutdown_failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        proc.exit(1);
      }
    })();
  };

  proc.once('SIGTERM', () => shutdown('SIGTERM'));
  proc.once('SIGINT', () => shutdown('SIGINT'));
}
