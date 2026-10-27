import { GatewayWebhookEvent, PaymentAuditLog, PaymentDomainEvent } from './entities';
import {
  markWebhookEventProcessed,
  writeDomainEvent,
  writePaymentAudit,
} from './finance-persistence';

function fakeManager() {
  const execute = jest.fn().mockResolvedValue(undefined);
  const orIgnore = jest.fn(() => ({ execute }));
  const values = jest.fn(() => ({ orIgnore }));
  const into = jest.fn(() => ({ values }));
  const insertBuilder = jest.fn(() => ({ into }));
  return {
    insert: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(() => ({ insert: insertBuilder })),
    spies: { into, values, orIgnore, execute },
  };
}

describe('finance persistence helpers', () => {
  it('writePaymentAudit inserts one audit row with no client IP', async () => {
    const manager = fakeManager();
    await writePaymentAudit(manager as never, {
      actorId: 'admin-1',
      action: 'refund.approved',
      resourceType: 'refund',
      resourceId: 'refund-1',
      details: { amount_minor: 500 },
    });

    expect(manager.insert).toHaveBeenCalledWith(PaymentAuditLog, {
      actor_id: 'admin-1',
      action: 'refund.approved',
      resource_type: 'refund',
      resource_id: 'refund-1',
      details: { amount_minor: 500 },
      ip_address: null,
    });
  });

  it('writeDomainEvent enqueues an unpublished outbox row and ignores duplicate dedupe keys', async () => {
    const manager = fakeManager();
    await writeDomainEvent(manager as never, 'settlement.created', 'settlement:1:created', {
      settlement_id: '1',
    });

    expect(manager.spies.into).toHaveBeenCalledWith(PaymentDomainEvent);
    expect(manager.spies.values).toHaveBeenCalledWith({
      event_name: 'settlement.created',
      dedupe_key: 'settlement:1:created',
      payload: { settlement_id: '1' },
      published_at: null,
      attempts: 0,
      last_error: null,
    });
    expect(manager.spies.orIgnore).toHaveBeenCalledTimes(1);
    expect(manager.spies.execute).toHaveBeenCalledTimes(1);
  });

  it('markWebhookEventProcessed releases the whole lease, heartbeat included, and saves on the caller manager', async () => {
    const manager = fakeManager();
    const event = {
      status: 'processing',
      processed_at: null,
      error_message: 'boom',
      last_error: 'boom',
      lease_token: 'lease',
      claimed_by: 'worker-1',
      lease_expires_at: new Date(),
      heartbeat_at: new Date(),
      next_retry_at: new Date(),
    } as unknown as GatewayWebhookEvent;

    await markWebhookEventProcessed(manager as never, event);

    expect(event).toMatchObject({
      status: 'processed',
      error_message: null,
      last_error: null,
      lease_token: null,
      claimed_by: null,
      lease_expires_at: null,
      heartbeat_at: null,
      next_retry_at: null,
    });
    expect(event.processed_at).toBeInstanceOf(Date);
    expect(manager.save).toHaveBeenCalledWith(event);
  });
});
