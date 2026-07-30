import * as crypto from 'node:crypto';

import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ProviderCheckoutInput, ProviderWebhookRequest } from '../payment-gateway.interface';
import { PaymobGateway } from './paymob.gateway';

const WEBHOOK_SECRET = 'test-webhook-secret';

function config(overrides: Partial<Record<string, string>> = {}): ConfigService {
  const values: Record<string, string> = {
    PAYMOB_API_KEY: 'api-key',
    PAYMOB_SECRET_KEY: 'secret-key',
    PAYMOB_CARD_INTEGRATION_ID: '999',
    PAYMOB_IFRAME_ID: '123',
    PAYMOB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PAYMOB_BASE_URL: 'https://accept.paymob.test',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

function transaction(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 123,
    amount_cents: 10_000,
    currency: 'EGP',
    success: true,
    pending: false,
    error_occured: false,
    is_3d_secure: true,
    is_auth: false,
    is_capture: false,
    is_refunded: false,
    is_voided: false,
    is_standalone_payment: true,
    has_parent_transaction: false,
    integration_id: 999,
    owner: 1,
    created_at: '2026-01-01T00:00:00Z',
    source_data: { pan: '2345', sub_type: 'MasterCard', type: 'card' },
    order: { id: 555, merchant_order_id: 'payment-1' },
    ...overrides,
  };
}

function sign(obj: Record<string, unknown>, secret = WEBHOOK_SECRET): string {
  const source = obj.source_data as Record<string, unknown>;
  const order = obj.order as Record<string, unknown>;
  const content = [
    obj.amount_cents,
    obj.created_at,
    obj.currency,
    obj.error_occured,
    obj.has_parent_transaction,
    obj.id,
    obj.integration_id,
    obj.is_3d_secure,
    obj.is_auth,
    obj.is_capture,
    obj.is_refunded,
    obj.is_standalone_payment,
    obj.is_voided,
    order.id,
    obj.owner,
    obj.pending,
    source.pan,
    source.sub_type,
    source.type,
    obj.success,
  ].join('');
  return crypto.createHmac('sha512', secret).update(content).digest('hex');
}

function webhookRequest(overrides: Partial<Record<string, unknown>> = {}): ProviderWebhookRequest {
  const obj = transaction(overrides);
  return {
    payload: {
      type: 'TRANSACTION',
      obj,
      hmac: sign(obj),
    },
  };
}

function response(body: Record<string, unknown>, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function checkoutInput(): ProviderCheckoutInput {
  return {
    paymentId: 'payment-1',
    orderId: 'order-1',
    orderNumber: 'ORD-1',
    amountMinor: 10_000,
    currency: 'EGP',
    billingData: {
      first_name: 'Test',
      last_name: 'Student',
      email: 'student@example.test',
      phone_number: '01000000000',
      city: 'Cairo',
      state: 'Cairo',
      country: 'EG',
    },
  };
}

describe('PaymobGateway', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a hosted checkout through auth, order registration, and payment key APIs', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ token: 'auth-token' }))
      .mockResolvedValueOnce(response({ id: 555 }))
      .mockResolvedValueOnce(response({ token: 'payment-key' }));
    const gateway = new PaymobGateway(config());

    await expect(gateway.createCheckout(checkoutInput())).resolves.toEqual({
      redirectUrl:
        'https://accept.paymob.test/api/acceptance/iframes/123?payment_token=payment-key',
      providerReference: '555',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://accept.paymob.test/api/auth/tokens');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://accept.paymob.test/api/ecommerce/orders');
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      'https://accept.paymob.test/api/acceptance/payment_keys',
    );
    const orderRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(orderRequest).toMatchObject({
      merchant_order_id: 'payment-1',
      amount_cents: 10_000,
      currency: 'EGP',
    });
  });

  it('reissues a hosted checkout session for an existing Paymob order without registering another order', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ token: 'auth-token' }))
      .mockResolvedValueOnce(response({ token: 'payment-key' }));
    const gateway = new PaymobGateway(config());

    await expect(gateway.createCheckoutSession(checkoutInput(), '555')).resolves.toEqual({
      redirectUrl:
        'https://accept.paymob.test/api/acceptance/iframes/123?payment_token=payment-key',
      providerReference: '555',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://accept.paymob.test/api/auth/tokens');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://accept.paymob.test/api/acceptance/payment_keys',
    );
    const keyRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(keyRequest).toMatchObject({ order_id: 555, amount_cents: 10_000 });
  });

  it('retrieves and validates transaction-level details by Paymob order and merchant reference', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ token: 'auth-token' }))
      .mockResolvedValueOnce(response(transaction()));
    const gateway = new PaymobGateway(config());

    await expect(gateway.getTransactionByOrderReference('555', 'payment-1')).resolves.toEqual({
      transactionId: '123',
      status: 'succeeded',
      amountMinor: 10_000,
      currency: 'EGP',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      providerOrderReference: '555',
      merchantReference: 'payment-1',
      refundedAmountMinor: 0,
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://accept.paymob.test/api/ecommerce/orders/transaction_inquiry',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      auth_token: 'auth-token',
      merchant_order_id: 'payment-1',
      order_id: 555,
    });
  });

  it('fails closed when transaction inquiry does not bind to the requested order and merchant reference', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ token: 'auth-token' }))
      .mockResolvedValueOnce(
        response(transaction({ order: { id: 556, merchant_order_id: 'other' } })),
      );
    const gateway = new PaymobGateway(config());

    await expect(gateway.getTransactionByOrderReference('555', 'payment-1')).resolves.toBeNull();
  });

  it('fails closed when any required setting is missing', async () => {
    const gateway = new PaymobGateway(config({ PAYMOB_SECRET_KEY: '' }));
    await expect(gateway.createCheckout(checkoutInput())).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(globalThis.fetch).toBeDefined();
  });

  it('verifies the documented HMAC field order and maps to a neutral event', () => {
    const gateway = new PaymobGateway(config());
    const request = webhookRequest();

    expect(gateway.verifyWebhook(request)).toBe(true);
    expect(gateway.parseWebhook(request)).toMatchObject({
      provider: 'paymob',
      merchantReference: 'payment-1',
      providerOrderReference: '555',
      transactionId: '123',
      amountMinor: 10_000,
      currency: 'EGP',
      outcome: 'succeeded',
    });
  });

  it('rejects forged, tampered, unsigned, and wrong-integration callbacks', () => {
    const gateway = new PaymobGateway(config());
    const valid = webhookRequest();
    const forged = { ...valid, signature: 'deadbeef' };
    const tampered = webhookRequest();
    (tampered.payload as Record<string, unknown>).obj = transaction({ amount_cents: 1 });

    expect(gateway.verifyWebhook(forged)).toBe(false);
    expect(gateway.verifyWebhook(tampered)).toBe(false);
    expect(gateway.verifyWebhook({ payload: { type: 'TRANSACTION', obj: transaction() } })).toBe(
      false,
    );
    expect(() => gateway.parseWebhook(webhookRequest({ integration_id: 1000 }))).toThrow(
      BadRequestException,
    );
  });

  it.each([
    [{ is_refunded: true }, 'refunded'],
    [{ is_voided: true }, 'failed'],
    [{ success: false, pending: true }, 'pending'],
    [{ success: false, error_occured: true }, 'failed'],
  ])('maps provider state %j to %s', (state, expected) => {
    const gateway = new PaymobGateway(config());
    const request = webhookRequest(state);
    expect(gateway.verifyWebhook(request)).toBe(true);
    expect(gateway.parseWebhook(request).outcome).toBe(expected);
  });

  it('submits full refunds with the existing transaction reference', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ token: 'auth-token' }))
      .mockResolvedValueOnce(response({ id: 456, success: true, is_refund: true }));
    const gateway = new PaymobGateway(config());

    await expect(
      gateway.refund({
        providerReference: '123',
        amountMinor: 10_000,
        currency: 'EGP',
        idempotencyKey: 'refund-1',
      }),
    ).resolves.toEqual({
      providerReference: '456',
      status: 'succeeded',
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://accept.paymob.test/api/acceptance/void_refund/refund',
    );
  });
});
