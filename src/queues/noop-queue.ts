import { Logger } from '@nestjs/common';

/**
 * Drop-in stand-in for a real BullMQ `Queue`, used only when Redis is not
 * configured in development (see `areQueuesEnabled` in `queues.constants.ts`).
 * Registered under the exact same DI token a real queue would use
 * (`getQueueToken(name)` — see `register-queues.util.ts`), so every existing
 * `@InjectQueue(name)` consumer resolves and keeps working unmodified; only
 * whether it talks to a real Redis-backed queue changes.
 *
 * Implements only the subset of `Queue`'s surface actually called anywhere in
 * this codebase (`add`, `getJob`, `getJobCounts`, `isPaused`, `name`) — grep
 * for `@InjectQueue` before adding more. Every method resolves successfully
 * instead of touching Redis, so route handlers that enqueue a job without
 * wrapping it in try/catch (a safe assumption in production, where queues are
 * mandatory) don't 500 in development just because a background job wasn't
 * enqueued.
 */
export class NoopQueue {
  private readonly logger = new Logger('NoopQueue');

  public constructor(public readonly name: string) {}

  public add(jobName: string): Promise<null> {
    this.logger.warn(
      `Queue "${this.name}" is disabled (no Redis configured in development) — ` +
        `job "${jobName}" was not enqueued.`,
    );
    return Promise.resolve(null);
  }

  public addBulk(): Promise<never[]> {
    return Promise.resolve([]);
  }

  public getJob(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public getJobCounts(): Promise<Record<string, number>> {
    return Promise.resolve({});
  }

  public isPaused(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
