import { randomUUID } from 'node:crypto';

import { EventEmitter2 } from '@nestjs/event-emitter';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { PaymentOperationsService } from '../../src/payments/services/payment-operations.service';
import { PaymentDomainEvent } from '../../src/payments/entities/payment-domain-event.entity';
import { createE2EApp, resetDatabase } from './fixtures';

/**
 * Phase 4 of the marketplace remediation (money path), MP-12: the payments outbox must not mark a
 * marketplace settlement event "published" while nothing is registered to handle it, because a payment
 * captured just before the module is switched off would then never enrol the learner.
 */
describe('marketplace money path (Phase 4)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  const events = () => dataSource.getRepository(PaymentDomainEvent);

  async function queue(eventName: string): Promise<string> {
    const saved = await events().save(
      events().create({
        event_name: eventName,
        dedupe_key: `e2e:${randomUUID()}`,
        payload: { payment_id: randomUUID() },
        published_at: null,
      }),
    );
    return saved.id;
  }

  it('keeps a marketplace settlement event queued while it has no listener, and delivers it once one exists (MP-12)', async () => {
    const emitter = app.get(EventEmitter2);
    const operations = app.get(PaymentOperationsService);
    const name = 'payment.marketplace_item_succeeded';
    const registered = emitter.listeners(name);
    emitter.removeAllListeners(name); // as if MARKETPLACE_ENABLED were false
    const id = await queue(name);

    try {
      expect(await operations.publishOutbox()).toBe(0);
      const deferred = await events().findOneOrFail({ where: { id } });
      expect(deferred).toMatchObject({
        status: 'pending',
        published_at: null,
        attempts: 0,
        lease_token: null,
      });
      expect(deferred.next_retry_at).toBeInstanceOf(Date);

      // Re-enabled: the very same fact is delivered, not lost.
      const received: unknown[] = [];
      emitter.on(name, (payload: unknown) => received.push(payload));
      await events().update({ id }, { next_retry_at: null });
      expect(await operations.publishOutbox()).toBe(1);
      expect(received).toHaveLength(1);
      expect(await events().findOneOrFail({ where: { id } })).toMatchObject({
        status: 'published',
      });
    } finally {
      emitter.removeAllListeners(name);
      for (const listener of registered) emitter.on(name, listener as never);
    }
  });

  it('still publishes events that are not marketplace ones when they have no listener (unchanged academic behaviour)', async () => {
    const operations = app.get(PaymentOperationsService);
    const id = await queue(`payment.e2e_unlistened_${randomUUID().slice(0, 8)}`);

    await operations.publishOutbox();

    expect(await events().findOneOrFail({ where: { id } })).toMatchObject({ status: 'published' });
  });
});
