import * as crypto from 'node:crypto';

import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ProviderCheckoutInput, ProviderWebhookRequest } from '../payment-gateway.interface';
import { EasyKashGateway } from './easykash.gateway';
import { parseEasyKashAmountMinor } from './easykash.mapper';

const HMAC_SECRET = 'da9fe30575517d987762a859842b5631';
const PAYMENT_ID = '3f2b8c1e-6a4d-4c43-9d55-0c1f9b2a7e10';

function config(overrides: Partial<Record<string, string>> = {}): ConfigService {
  const values: Record<string, string> = {
    EASYKASH_API_KEY: 'api-key',
    EASYKASH_HMAC_SECRET: HMAC_SECRET,
    EASYKASH_API_BASE_URL: 'https://back.easykash.net',
    BACKEND_URL: 'https://api.learnix.school',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

function checkoutInput(overrides: Partial<ProviderCheckoutInput> = {}): ProviderCheckoutInput {
  return {
    paymentId: PAYMENT_ID,
    orderId: 'order-1',
    orderNumber: 'ORD-1',
    amountMinor: 12_550,
    currency: 'EGP',
    billingData: {
      first_name: 'Sara',
      last_name: 'Ali',
      email: 'sara@example.test',
      phone_number: '01010101010',
      city: 'Cairo',
      state: 'Cairo',
      country: 'EG',
    },
    ...overrides,
  } as ProviderCheckoutInput;
}

/** The exact payload from the official "Callback response verification" page. */
const DOC_PAYLOAD = {
  ProductCode: 'EDV4471',
  Amount: '11.00',
  ProductType: 'Direct Pay',
  PaymentMethod: 'Cash Through Fawry',
  BuyerName: 'mee',
  BuyerEmail: 'test@mail.com',
  BuyerMobile: '0123456789',
  status: 'PAID',
  voucher: '',
  easykashRef: '2911105009',
  VoucherData: 'Direct Pay',
  customerReference: 'TEST11111',
  signatureHash:
    '0bd9ce502950ffa358314c170dace42e7ba3e0c776f5a32eb15c3d496bc9c294835036dd90d4f287233b800c9bde2f6591b6b8a1f675b6bfe64fd799da29d1d0',
};

function signedPayload(
  overrides: Partial<Record<string, unknown>> = {},
  secret = HMAC_SECRET,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ProductCode: 'ABC1234',
    Amount: '125.50',
    ProductType: 'Direct Pay',
    PaymentMethod: 'Credit & Debit Card',
    status: 'PAID',
    easykashRef: '99887766',
    customerReference: PAYMENT_ID,
    BuyerName: 'Sara',
    ...overrides,
  };
  const content = [
    'ProductCode',
    'Amount',
    'ProductType',
    'PaymentMethod',
    'status',
    'easykashRef',
    'customerReference',
  ]
    .map((key) => String(payload[key]))
    .join('');
  if (overrides['signatureHash'] === undefined) {
    payload['signatureHash'] = crypto.createHmac('sha512', secret).update(content).digest('hex');
  }
  return payload;
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('EasyKashGateway', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createCheckoutOrder', () => {
    it('sends the documented Pay API request and returns the hosted product code', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({ redirectUrl: 'https://www.easykash.net/DirectPayV1/ABC1234' }),
      );
      const gateway = new EasyKashGateway(config());

      const reference = await gateway.createCheckoutOrder(
        checkoutInput({ expiresAt: new Date(Date.now() + 25 * 3_600_000) }),
      );

      expect(reference).toBe('ABC1234');
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://back.easykash.net/api/directpayv1/pay');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['authorization']).toBe('api-key');
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({
        amount: 125.5,
        currency: 'EGP',
        name: 'Sara Ali',
        email: 'sara@example.test',
        mobile: '01010101010',
        customerReference: PAYMENT_ID,
        redirectUrl: `https://api.learnix.school/api/v1/payments/easykash/return/${PAYMENT_ID}`,
        paymentOptions: [2, 4, 6, 31, 35, 1, 5],
        cashExpiry: 24,
      });
    });

    it('drops cash vouchers when the order expires within the hour', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({ redirectUrl: 'https://www.easykash.net/DirectPayV1/ABC1234' }),
      );
      const gateway = new EasyKashGateway(config());

      await gateway.createCheckoutOrder(
        checkoutInput({ expiresAt: new Date(Date.now() + 30 * 60_000) }),
      );

      const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.paymentOptions).toEqual([2, 4, 6, 31, 35]);
      expect(body).not.toHaveProperty('cashExpiry');
    });

    it('bounds the voucher validity by the remaining order lifetime', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({ redirectUrl: 'https://www.easykash.net/DirectPayV1/ABC1234' }),
      );
      const gateway = new EasyKashGateway(config());

      await gateway.createCheckoutOrder(
        checkoutInput({ expiresAt: new Date(Date.now() + 5 * 3_600_000 + 60_000) }),
      );

      const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.cashExpiry).toBe(5);
    });

    it.each([
      'https://evil.example/DirectPayV1/ABC1234',
      'http://www.easykash.net/DirectPayV1/ABC1234',
      'https://www.easykash.net/DirectPayV1/ABC1234?x=1',
      'https://user@www.easykash.net/DirectPayV1/ABC1234',
      'https://www.easykash.net/Other/ABC1234',
      'https://www.easykash.net/DirectPayV1/',
      '',
      undefined,
      42,
    ])('rejects an unexpected redirect link %p and creates no reference', async (redirectUrl) => {
      fetchSpy.mockResolvedValue(jsonResponse({ redirectUrl }));
      const gateway = new EasyKashGateway(config());

      await expect(gateway.createCheckoutOrder(checkoutInput())).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('fails closed on authentication errors and server errors', async () => {
      const gateway = new EasyKashGateway(config());
      for (const status of [401, 403, 500]) {
        fetchSpy.mockResolvedValueOnce(jsonResponse({}, { ok: false, status }));
        await expect(gateway.createCheckoutOrder(checkoutInput())).rejects.toBeInstanceOf(
          InternalServerErrorException,
        );
      }
    });

    it('fails closed on a network timeout without retrying', async () => {
      fetchSpy.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
      const gateway = new EasyKashGateway(config());

      await expect(gateway.createCheckoutOrder(checkoutInput())).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('refuses non-EGP currencies and non-positive amounts', async () => {
      const gateway = new EasyKashGateway(config());
      await expect(
        gateway.createCheckoutOrder(checkoutInput({ currency: 'USD' })),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      await expect(
        gateway.createCheckoutOrder(checkoutInput({ amountMinor: 0 })),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fails closed when configuration is incomplete', async () => {
      const gateway = new EasyKashGateway(config({ EASYKASH_API_KEY: '' }));
      await expect(gateway.createCheckoutOrder(checkoutInput())).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('createCheckoutSession', () => {
    it('rebuilds the hosted link from the stored product code without any network call', async () => {
      const gateway = new EasyKashGateway(config());

      const session = await gateway.createCheckoutSession(checkoutInput(), 'ABC1234');

      expect(session).toEqual({
        redirectUrl: 'https://www.easykash.net/DirectPayV1/ABC1234',
        providerReference: 'ABC1234',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a malformed stored reference', async () => {
      const gateway = new EasyKashGateway(config());
      await expect(
        gateway.createCheckoutSession(checkoutInput(), '../evil?x=1'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('webhook verification', () => {
    const gateway = new EasyKashGateway(config());

    it('accepts the official documentation example (known-answer test)', () => {
      expect(gateway.verifyWebhook({ payload: DOC_PAYLOAD })).toBe(true);
    });

    it('accepts a correctly signed callback', () => {
      expect(gateway.verifyWebhook({ payload: signedPayload() })).toBe(true);
    });

    it('rejects a signature made with another secret', () => {
      expect(gateway.verifyWebhook({ payload: signedPayload({}, 'wrong-secret') })).toBe(false);
    });

    it.each([
      ['ProductCode', 'ZZZ9999'],
      ['Amount', '1.00'],
      ['ProductType', 'Invoice'],
      ['PaymentMethod', 'Meeza'],
      ['status', 'FAILED'],
      ['easykashRef', '1'],
      ['customerReference', 'other-payment'],
    ])('rejects a payload with a tampered %s', (field, value) => {
      const payload = { ...signedPayload(), [field]: value };
      expect(gateway.verifyWebhook({ payload })).toBe(false);
    });

    it('ignores unsigned fields such as the buyer name', () => {
      const payload = { ...signedPayload(), BuyerName: 'someone else' };
      expect(gateway.verifyWebhook({ payload })).toBe(true);
    });

    it.each([
      ['a missing field', (p: Record<string, unknown>) => delete p['easykashRef']],
      ['a numeric field', (p: Record<string, unknown>) => (p['Amount'] = 125.5)],
      ['a null field', (p: Record<string, unknown>) => (p['status'] = null)],
      ['a missing signature', (p: Record<string, unknown>) => delete p['signatureHash']],
      ['a short signature', (p: Record<string, unknown>) => (p['signatureHash'] = 'abcd')],
      ['a non-hex signature', (p: Record<string, unknown>) => (p['signatureHash'] = 'z'.repeat(128))],
    ])('rejects %s', (_label, mutate) => {
      const payload = signedPayload();
      mutate(payload);
      expect(gateway.verifyWebhook({ payload })).toBe(false);
    });

    it.each([null, undefined, 'text', 12, []])('rejects a non-object payload %p', (payload) => {
      expect(gateway.verifyWebhook({ payload })).toBe(false);
    });

    it('fails closed when the HMAC secret is not configured', () => {
      const unconfigured = new EasyKashGateway(config({ EASYKASH_HMAC_SECRET: '' }));
      expect(unconfigured.verifyWebhook({ payload: signedPayload({}, '') })).toBe(false);
    });

    it('does not accept a signature supplied through the query string', () => {
      const payload = signedPayload();
      const request = { payload: { ...payload, signatureHash: undefined }, signature: 'x' };
      expect(gateway.verifyWebhook(request as unknown as ProviderWebhookRequest)).toBe(false);
    });
  });

  describe('parseWebhook', () => {
    const gateway = new EasyKashGateway(config());

    it('maps a signed callback to a normalised succeeded event', () => {
      const event = gateway.parseWebhook({ payload: signedPayload({ voucher: '3242343' }) });

      expect(event).toMatchObject({
        provider: 'easykash',
        merchantReference: PAYMENT_ID,
        providerOrderReference: 'ABC1234',
        transactionId: '99887766',
        amountMinor: 12_550,
        currency: 'EGP',
        outcome: 'succeeded',
      });
      expect(event.occurredAt).toBeUndefined();
      expect(event.isLive).toBeUndefined();
      expect(event.payload).not.toHaveProperty('BuyerName');
      expect(event.payload['voucher']).toBe('3242343');
    });

    it('produces a stable event id so duplicate deliveries collapse into one event', () => {
      const first = gateway.parseWebhook({ payload: signedPayload() });
      const second = gateway.parseWebhook({
        payload: { ...signedPayload(), Timestamp: '1700000000' },
      });
      expect(second.providerEventId).toBe(first.providerEventId);
    });

    it('rejects any status other than PAID', () => {
      expect(() => gateway.parseWebhook({ payload: signedPayload({ status: 'FAILED' }) })).toThrow(
        BadRequestException,
      );
    });

    it.each(['1e3', '-5', '10.005', '0', '0.00', 'abc', ''])('rejects the amount %p', (amount) => {
      expect(() => gateway.parseWebhook({ payload: signedPayload({ Amount: amount }) })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('amount parsing', () => {
    it.each([
      ['11.00', 1100],
      ['50.5', 5050],
      ['125.50', 12_550],
      ['7', 700],
      ['0.07', 7],
    ])('converts %s to %d minor units without float drift', (value, expected) => {
      expect(parseEasyKashAmountMinor(value)).toBe(expected);
    });
  });

  describe('getTransactionByOrderReference (payment inquiry)', () => {
    const inquiry = (status: string, extra: Record<string, unknown> = {}) =>
      jsonResponse({ PaymentMethod: 'Meeza', Amount: '125.50', status, easykashRef: '99887766', ...extra });

    it('posts the customer reference with the API key and maps PAID', async () => {
      fetchSpy.mockResolvedValue(inquiry('PAID'));
      const gateway = new EasyKashGateway(config());

      const details = await gateway.getTransactionByOrderReference('ABC1234', PAYMENT_ID);

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://back.easykash.net/api/cash-api/inquire');
      expect((init.headers as Record<string, string>)['authorization']).toBe('api-key');
      expect(JSON.parse(init.body as string)).toEqual({ customerReference: PAYMENT_ID });
      expect(details).toMatchObject({
        status: 'succeeded',
        amountMinor: 12_550,
        currency: 'EGP',
        transactionId: '99887766',
        providerOrderReference: 'ABC1234',
        merchantReference: PAYMENT_ID,
        refundedAmountMinor: 0,
      });
      expect(details?.occurredAt).toBeUndefined();
    });

    it.each([
      ['DELIVERED', 'succeeded'],
      ['NEW', 'pending'],
      ['FAILED', 'failed'],
      ['EXPIRED', 'failed'],
      ['CANCELED', 'failed'],
    ])('maps %s to %s', async (providerStatus, expected) => {
      fetchSpy.mockResolvedValue(inquiry(providerStatus));
      const details = await new EasyKashGateway(config()).getTransactionByOrderReference(
        'ABC1234',
        PAYMENT_ID,
      );
      expect(details?.status).toBe(expected);
    });

    it('reports the full amount as refunded for REFUNDED', async () => {
      fetchSpy.mockResolvedValue(inquiry('REFUNDED'));
      const details = await new EasyKashGateway(config()).getTransactionByOrderReference(
        'ABC1234',
        PAYMENT_ID,
      );
      expect(details).toMatchObject({ status: 'refunded', refundedAmountMinor: 12_550 });
    });

    it.each([
      ['an unknown status', inquiry('MYSTERY')],
      ['a bad amount', inquiry('PAID', { Amount: 'oops' })],
      ['a paid state without a reference', inquiry('PAID', { easykashRef: undefined })],
    ])('returns null for %s', async (_label, response) => {
      fetchSpy.mockResolvedValue(response);
      const details = await new EasyKashGateway(config()).getTransactionByOrderReference(
        'ABC1234',
        PAYMENT_ID,
      );
      expect(details).toBeNull();
    });

    it('propagates an unavailable error on gateway failure', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({}, { ok: false, status: 500 }));
      await expect(
        new EasyKashGateway(config()).getTransactionByOrderReference('ABC1234', PAYMENT_ID),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('capabilities', () => {
    it('does not support automatic refunds and refuses to attempt one', async () => {
      const gateway = new EasyKashGateway(config());
      expect(gateway.supportsRefunds()).toBe(false);
      await expect(
        gateway.refund({
          providerReference: 'x',
          amountMinor: 100,
          currency: 'EGP',
          idempotencyKey: 'k',
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reports configuration status', () => {
      expect(new EasyKashGateway(config()).getConfigurationStatus()).toMatchObject({
        enabled: true,
        configured: true,
      });
      expect(
        new EasyKashGateway(config({ EASYKASH_HMAC_SECRET: '' })).getConfigurationStatus().configured,
      ).toBe(false);
    });
  });
});
