import { MarketplaceOrderStatus } from '../common/enums';
import { MarketplaceCheckoutService } from './checkout.service';

const BILLING = {
  first_name: 'Nour',
  last_name: 'Ahmed',
  email: 'nour@example.com',
  phone_number: '01012345678',
  city: 'Cairo',
  state: 'Cairo',
  country: 'EG',
};

function buildService(
  opts: {
    order?: Record<string, unknown> | null;
    existingPayment?: Record<string, unknown> | null;
    cached?: { isProcessed: boolean; cachedResult?: unknown };
  } = {},
) {
  const order =
    'order' in opts
      ? opts.order
      : {
          id: 'order-1',
          order_number: 'MP-ABC123',
          learner_id: 'learner-1',
          status: MarketplaceOrderStatus.AWAITING_PAYMENT,
          net_amount_minor: 5000,
          currency: 'EGP',
          payment_id: null,
        };

  const payments = {
    findOne: jest.fn().mockResolvedValue(opts.existingPayment ?? null),
    create: jest.fn((data: Record<string, unknown>) => data),
    save: jest.fn(async (data: Record<string, unknown>) => ({ id: 'payment-1', ...data })),
  };
  const orders = {
    findOne: jest.fn().mockResolvedValue(order),
    save: jest.fn(async (data: Record<string, unknown>) => data),
  };
  const gateway = {
    name: 'easykash',
    createCheckoutOrder: jest.fn().mockResolvedValue('easykash-order-1'),
    createCheckoutSession: jest
      .fn()
      .mockResolvedValue({
        redirectUrl: 'https://www.easykash.net/pay/xyz',
        providerReference: 'easykash-order-1',
      }),
  };
  const idempotency = {
    checkPaymentRequest: jest.fn().mockResolvedValue(opts.cached ?? { isProcessed: false }),
    storePaymentResult: jest.fn().mockResolvedValue(undefined),
  };

  const service = new MarketplaceCheckoutService(
    gateway as never,
    payments as never,
    orders as never,
    idempotency as never,
  );
  return { service, payments, orders, gateway, idempotency };
}

describe('MarketplaceCheckoutService (T097)', () => {
  it('creates a Payment row and a gateway checkout session for an awaiting-payment order', async () => {
    const { service, payments, gateway } = buildService();
    const result = await service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-1');

    expect(payments.save).toHaveBeenCalled();
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
  });

  it('reuses an existing Payment/provider reference instead of creating a second gateway order (idempotent within one order)', async () => {
    const { service, payments, gateway } = buildService({
      existingPayment: { id: 'payment-1', provider_order_reference: 'easykash-order-1' },
    });
    await service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-1');

    expect(payments.create).not.toHaveBeenCalled();
    expect(gateway.createCheckoutOrder).not.toHaveBeenCalled();
    expect(gateway.createCheckoutSession).toHaveBeenCalled();
  });

  it('replays the exact cached result for a repeated Idempotency-Key without touching the gateway again', async () => {
    const cachedResult = {
      order_id: 'order-1',
      payment_id: 'payment-1',
      redirect_url: 'https://cached',
      amount_minor: 5000,
      currency: 'EGP',
    };
    const { service, gateway } = buildService({ cached: { isProcessed: true, cachedResult } });

    const result = await service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-1');
    expect(result).toEqual(cachedResult);
    expect(gateway.createCheckoutOrder).not.toHaveBeenCalled();
  });

  it('refuses checkout for an order that is not awaiting payment', async () => {
    const { service } = buildService({
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
    ).rejects.toThrow();
  });

  it('404s rather than 403s for an order that does not belong to (or does not exist for) the caller', async () => {
    const { service } = buildService({ order: null });
    await expect(
      service.createCheckout('learner-1', 'order-1', BILLING, 'idem-key-1'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
