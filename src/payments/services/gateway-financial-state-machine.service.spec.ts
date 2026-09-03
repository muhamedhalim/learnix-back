import { ItemType } from '../entities/item-type.enum';
import { GatewayFinancialStateMachineService } from './gateway-financial-state-machine.service';

/**
 * Focused on the marketplace branch only (payment.item_type ===
 * 'marketplace_course') — the pre-existing academic/cart-checkout branches
 * are already exercised end-to-end via the rest of the `src/payments`
 * suite and are deliberately untouched by this change.
 */
describe('GatewayFinancialStateMachineService — marketplace branch', () => {
  function buildManager(opts: { payment: Record<string, unknown> | null; event?: Record<string, unknown> }) {
    const insertBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const event = opts.event ?? { id: 'event-1', status: 'processing', lease_token: 'lease-1' };
    const manager = {
      findOne: jest.fn(async (entity: { name?: string }) => {
        const name = typeof entity === 'function' ? entity.name : String(entity);
        if (name === 'GatewayWebhookEvent') return event;
        if (name === 'Payment') return opts.payment;
        return null;
      }),
      save: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(insertBuilder),
    };
    return { manager, insertBuilder, event };
  }

  function buildService(manager: unknown) {
    const dataSource = {
      transaction: jest.fn((a: unknown, b: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as (m: unknown) => unknown;
        return fn(manager);
      }),
    };
    const finalizer = { finalizeSuccessfulPayment: jest.fn() };
    const refunds = { completeProviderNotificationInTransaction: jest.fn() };
    const cartCheckout = { finalizeSuccessfulGatewayPayment: jest.fn() };
    return new GatewayFinancialStateMachineService(dataSource as never, finalizer as never, refunds as never, cartCheckout as never);
  }

  const marketplacePayment = { id: 'payment-1', item_type: ItemType.MARKETPLACE_COURSE, item_id: 'order-1', order_id: null, cart_checkout_id: null };

  it('inserts a payment.marketplace_item_succeeded outbox row with the verified amount/currency, and marks the event processed', async () => {
    const { manager, insertBuilder, event } = buildManager({ payment: marketplacePayment });
    const service = buildService(manager);

    const outcome = await service.apply('event-1', 'lease-1', 'payment-1', {
      outcome: 'succeeded',
      transactionId: 'txn-1',
      amountMinor: 5000,
      currency: 'EGP',
    } as never);

    expect(outcome).toBe('completed');
    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: 'payment.marketplace_item_succeeded',
        dedupe_key: 'payment:payment-1:marketplace-item-succeeded',
        payload: expect.objectContaining({ payment_id: 'payment-1', order_id: 'order-1', verified_amount_minor: 5000, verified_currency: 'EGP' }),
      }),
    );
    expect(event.status).toBe('processed');
  });

  it('never touches the academic Order/CartCheckout paths for a marketplace payment', async () => {
    const { manager } = buildManager({ payment: marketplacePayment });
    const service = buildService(manager);
    const finalizer = (service as unknown as { finalizer: { finalizeSuccessfulPayment: jest.Mock } }).finalizer;
    const cartCheckout = (service as unknown as { cartCheckout: { finalizeSuccessfulGatewayPayment: jest.Mock } }).cartCheckout;

    await service.apply('event-1', 'lease-1', 'payment-1', { outcome: 'succeeded', transactionId: 'txn-1', amountMinor: 5000, currency: 'EGP' } as never);

    expect(finalizer.finalizeSuccessfulPayment).not.toHaveBeenCalled();
    expect(cartCheckout.finalizeSuccessfulGatewayPayment).not.toHaveBeenCalled();
    // manager.findOne is only ever asked for GatewayWebhookEvent and Payment — never Order.
    const requestedEntities = manager.findOne.mock.calls.map(([entity]: [{ name?: string }]) => entity.name ?? String(entity));
    expect(requestedEntities).not.toContain('Order');
  });

  it('inserts a distinct payment.marketplace_item_failed outbox row for a failed outcome (T105)', async () => {
    const { manager, insertBuilder, event } = buildManager({ payment: marketplacePayment });
    const service = buildService(manager);

    const outcome = await service.apply('event-1', 'lease-1', 'payment-1', {
      outcome: 'failed',
      transactionId: 'txn-1',
      amountMinor: 5000,
      currency: 'EGP',
    } as never);

    expect(outcome).toBe('completed');
    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: 'payment.marketplace_item_failed',
        dedupe_key: 'payment:payment-1:marketplace-item-failed',
        payload: expect.objectContaining({ payment_id: 'payment-1', order_id: 'order-1' }),
      }),
    );
    expect(event.status).toBe('processed');
  });

  it('does not insert any outbox row for a non-succeeded, non-failed outcome (e.g. pending) but still marks the lease released', async () => {
    const { manager, insertBuilder, event } = buildManager({ payment: marketplacePayment });
    const service = buildService(manager);

    await service.apply('event-1', 'lease-1', 'payment-1', { outcome: 'pending', transactionId: 'txn-1', amountMinor: 5000, currency: 'EGP' } as never);

    expect(insertBuilder.execute).not.toHaveBeenCalled();
    expect(event.status).toBe('processed');
  });

  it('replaying an already-processed event is a no-op before the payment is even looked up', async () => {
    const { manager } = buildManager({ payment: marketplacePayment, event: { id: 'event-1', status: 'processed' } });
    const service = buildService(manager);

    const outcome = await service.apply('event-1', 'lease-1', 'payment-1', { outcome: 'succeeded', transactionId: 'txn-1', amountMinor: 5000, currency: 'EGP' } as never);

    expect(outcome).toBe('completed');
    expect(manager.findOne).toHaveBeenCalledTimes(1);
  });
});
