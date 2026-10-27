import { Payment } from '../../payments/entities/payment.entity';
import { PaymentStatus } from '../../payments/entities/payment-status.enum';
import { MarketplaceOrderStatus } from '../common/enums';
import { MarketplaceCheckoutService } from './checkout.service';
import { MarketplaceOrder } from './entities';

const BILLING = {
  first_name: 'Nour',
  last_name: 'Ahmed',
  email: 'nour@example.com',
  phone_number: '01012345678',
  city: 'Cairo',
  state: 'Cairo',
  country: 'EG',
};

type Row = Record<string, unknown>;

/**
 * In-memory stand-in for the two rows the checkout touches. `transaction` runs the callback
 * directly (no isolation), so cross-request serialisation is exercised by the claim state that
 * the service writes — not by Postgres row locks, which the e2e suite covers.
 */
function buildService(
  opts: {
    order?: Row | null;
    existingPayment?: Row | null;
    cached?: { isProcessed: boolean; cachedResult?: unknown };
  } = {},
) {
  const state: { order: Row | null; payment: Row | null } = {
    order:
      'order' in opts
        ? (opts.order ?? null)
        : {
            id: 'order-1',
            order_number: 'MP-ABC123',
            learner_id: 'learner-1',
            status: MarketplaceOrderStatus.AWAITING_PAYMENT,
            net_amount_minor: 5000,
            currency: 'EGP',
            payment_id: null,
          },
    payment: opts.existingPayment ?? null,
  };

  const manager = {
    findOne: jest.fn((entity: unknown, options: { where: Row }) => {
      if (entity === MarketplaceOrder) {
        const { order } = state;
        const ok =
          order !== null &&
          order['id'] === options.where['id'] &&
          order['learner_id'] === options.where['learner_id'];
        return Promise.resolve(ok ? order : null);
      }
      if (entity === Payment) return Promise.resolve(state.payment);
      return Promise.resolve(null);
    }),
    create: jest.fn((_entity: unknown, data: Row) => ({ ...data })),
    save: jest.fn((entity: unknown, data: Row) => {
      if (entity === Payment) {
        // Unset nullable columns load as null from Postgres, never undefined.
        state.payment = {
          provider_order_reference: null,
          provider_reference: null,
          failure_reason: null,
          updated_at: new Date(),
          id: 'payment-1',
          ...data,
        };
        return Promise.resolve(state.payment);
      }
      state.order = data;
      return Promise.resolve(data);
    }),
  };
  const tx = { depth: 0, gatewayCallsInsideTransaction: 0 };
  const dataSource = {
    transaction: jest.fn(async (fn: (m: typeof manager) => Promise<unknown>) => {
      tx.depth += 1;
      try {
        return await fn(manager);
      } finally {
        tx.depth -= 1;
      }
    }),
  };
  const gateway = {
    name: 'easykash',
    createCheckoutOrder: jest.fn(() => {
      if (tx.depth > 0) tx.gatewayCallsInsideTransaction += 1;
      return Promise.resolve('easykash-order-1');
    }),
    createCheckoutSession: jest.fn(() => {
      if (tx.depth > 0) tx.gatewayCallsInsideTransaction += 1;
      return Promise.resolve({
        redirectUrl: 'https://www.easykash.net/pay/xyz',
        providerReference: 'easykash-order-1',
      });
    }),
  };
  const idempotency = {
    checkPaymentRequest: jest.fn().mockResolvedValue(opts.cached ?? { isProcessed: false }),
    storePaymentResult: jest.fn().mockResolvedValue(undefined),
  };

  const service = new MarketplaceCheckoutService(
    gateway as never,
    dataSource as never,
    idempotency as never,
  );
  return { service, state, tx, manager, dataSource, gateway, idempotency };
}

describe('MarketplaceCheckoutService (T097)', () => {
  it('creates a claimed Payment row and a gateway checkout session for an awaiting-payment order', async () => {
    const { service, state, gateway } = buildService();
    const result = await service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-1');

    expect(gateway.createCheckoutOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-1',
        orderNumber: 'MP-ABC123',
        amountMinor: 5000,
        currency: 'EGP',
      }),
    );
    expect(gateway.createCheckoutSession).toHaveBeenCalled();
    expect(result.redirect_url).toBe('https://www.easykash.net/pay/xyz');
    expect(result.amount_minor).toBe(5000);
    expect(state.payment).toMatchObject({
      status: PaymentStatus.PROCESSING,
      provider_order_reference: 'easykash-order-1',
      provider_reference: 'easykash-order-1',
      item_id: 'order-1',
    });
    expect(state.order).toMatchObject({ payment_id: 'payment-1' });
  });

  it('never calls the gateway while a database transaction is open', async () => {
    const { service, tx, gateway } = buildService();
    await service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-1');

    expect(gateway.createCheckoutOrder).toHaveBeenCalledTimes(1);
    expect(gateway.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(tx.gatewayCallsInsideTransaction).toBe(0);
    expect(tx.depth).toBe(0);
  });

  it('reuses an existing Payment/provider reference instead of creating a second gateway order (idempotent within one order)', async () => {
    const { service, manager, gateway } = buildService({
      existingPayment: {
        id: 'payment-1',
        status: PaymentStatus.PROCESSING,
        provider_order_reference: 'easykash-order-1',
      },
    });
    await service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-1');

    expect(manager.create).not.toHaveBeenCalled();
    expect(gateway.createCheckoutOrder).not.toHaveBeenCalled();
    expect(gateway.createCheckoutSession).toHaveBeenCalledWith(
      expect.anything(),
      'easykash-order-1',
    );
  });

  it('replays the exact cached result for a repeated Idempotency-Key without touching the gateway again', async () => {
    const cachedResult = {
      order_id: 'order-1',
      payment_id: 'payment-1',
      redirect_url: 'https://cached',
      amount_minor: 5000,
      currency: 'EGP',
    };
    const { service, gateway, dataSource } = buildService({
      cached: { isProcessed: true, cachedResult },
    });

    const result = await service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-1');
    expect(result).toEqual(cachedResult);
    expect(gateway.createCheckoutOrder).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('refuses checkout for an order that is not awaiting payment (409)', async () => {
    const { service, gateway } = buildService({
      order: {
        id: 'order-1',
        order_number: 'MP-1',
        learner_id: 'learner-1',
        status: MarketplaceOrderStatus.PAID,
        net_amount_minor: 5000,
        currency: 'EGP',
        payment_id: 'payment-1',
      },
    });
    await expect(
      service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(gateway.createCheckoutOrder).not.toHaveBeenCalled();
  });

  it('404s rather than 403s for an order that does not belong to (or does not exist for) the caller', async () => {
    const { service } = buildService({ order: null });
    await expect(
      service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-1'),
    ).rejects.toMatchObject({ status: 404 });
  });

  describe('concurrent checkouts with different Idempotency-Keys', () => {
    it('creates exactly one provider order: the second request is rejected while the first is mid-flight', async () => {
      const { service, state, gateway } = buildService();
      let releaseProvider!: (reference: string) => void;
      gateway.createCheckoutOrder.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            releaseProvider = resolve;
          }),
      );

      const first = service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-1');
      // Let the first request finish its claim transaction and reach the provider call.
      await new Promise((resolve) => setImmediate(resolve));
      expect(gateway.createCheckoutOrder).toHaveBeenCalledTimes(1);
      expect(state.payment).toMatchObject({
        status: PaymentStatus.PROCESSING,
        provider_order_reference: null,
      });

      await expect(
        service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-2'),
      ).rejects.toMatchObject({ status: 409 });
      expect(gateway.createCheckoutOrder).toHaveBeenCalledTimes(1);

      releaseProvider('easykash-order-1');
      await expect(first).resolves.toMatchObject({ payment_id: 'payment-1' });
      expect(state.payment).toMatchObject({ provider_order_reference: 'easykash-order-1' });
    });

    it('lets a second request proceed once the first one persisted its reference, without a new provider order', async () => {
      const { service, gateway } = buildService();
      await service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-1');
      await service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-2');

      expect(gateway.createCheckoutOrder).toHaveBeenCalledTimes(1);
      expect(gateway.createCheckoutSession).toHaveBeenCalledTimes(2);
    });

    it('reclaims a claim that never received its reference once it is stale (provider outage / crash)', async () => {
      const stale = new Date(Date.now() - 10 * 60_000);
      const { service, gateway, state } = buildService({
        existingPayment: {
          id: 'payment-1',
          status: PaymentStatus.PROCESSING,
          provider_order_reference: null,
          updated_at: stale,
        },
      });

      await service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-2');

      expect(gateway.createCheckoutOrder).toHaveBeenCalledTimes(1);
      expect(state.payment).toMatchObject({ provider_order_reference: 'easykash-order-1' });
    });

    it('rejects a fresh unreferenced claim with 409 and does not call the provider', async () => {
      const { service, gateway } = buildService({
        existingPayment: {
          id: 'payment-1',
          status: PaymentStatus.PROCESSING,
          provider_order_reference: null,
          updated_at: new Date(),
        },
      });

      await expect(
        service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-2'),
      ).rejects.toMatchObject({ status: 409 });
      expect(gateway.createCheckoutOrder).not.toHaveBeenCalled();
    });

    it('refuses to start payment from a terminal payment state (409)', async () => {
      const { service, gateway } = buildService({
        existingPayment: {
          id: 'payment-1',
          status: PaymentStatus.COMPLETED,
          provider_order_reference: null,
          updated_at: new Date(),
        },
      });

      await expect(
        service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-2'),
      ).rejects.toMatchObject({ status: 409 });
      expect(gateway.createCheckoutOrder).not.toHaveBeenCalled();
    });
  });
});
