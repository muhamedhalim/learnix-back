import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { JobsOptions } from 'bullmq';

import { areQueuesEnabled } from './queues.constants';
import { NoopQueue } from './noop-queue';

interface QueueRegistration {
  name: string;
  config: { defaultJobOptions: JobsOptions };
}

/**
 * Registers one or more BullMQ queues — or, when Redis isn't configured in
 * development (`areQueuesEnabled() === false`), provides a `NoopQueue` under
 * the exact same DI token (`getQueueToken(name)`) instead.
 *
 * This is what makes queues genuinely optional in development without
 * touching any of the ~10 services across the codebase that
 * `@InjectQueue(name)` a producer, or forcing them to guard every call with
 * `@Optional()`: they keep injecting the same token and calling `.add(...)`
 * exactly as before. Only whether that token resolves to a real Redis-backed
 * `Queue` or an inert `NoopQueue` changes.
 *
 * Call this instead of `BullModule.registerQueue(...)` everywhere queues are
 * registered (`queues.module.ts`, `attendance-codes.module.ts`,
 * `exams.module.ts`, `gamification.module.ts`, `notifications.module.ts`).
 */
export function registerQueues(...registrations: QueueRegistration[]): DynamicModule {
  if (areQueuesEnabled()) {
    return BullModule.registerQueue(
      ...registrations.map(({ name, config }) => ({ name, ...config })),
    );
  }

  const providers: Provider[] = registrations.map(({ name }) => ({
    provide: getQueueToken(name),
    useValue: new NoopQueue(name),
  }));

  return {
    module: class NoopQueuesModule {},
    providers,
    exports: providers.map((provider) => (provider as { provide: string }).provide),
  };
}
