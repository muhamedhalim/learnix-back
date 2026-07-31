import * as crypto from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { validatePaymobBaseUrl } from '../../../config/env.validation';
import { biBody } from '../../../i18n/error-translator.util';
import type {
  PaymentGateway,
  ProviderCheckoutInput,
  ProviderCheckoutResult,
  PaymentGatewayConfigurationStatus,
  ProviderPaymentStatus,
  ProviderTransactionDetails,
  ProviderRefundInput,
  ProviderRefundResult,
  ProviderWebhookEvent,
  ProviderWebhookRequest,
} from '../payment-gateway.interface';
import { mapPaymobWebhook, parsePaymobWebhook, paymobHmacContent } from './paymob.mapper';
import type {
  PaymobAuthResponse,
  PaymobOrderResponse,
  PaymobPaymentKeyResponse,
  PaymobRefundResponse,
  PaymobTransactionInquiryResponse,
} from './paymob.types';

const CURRENCY = 'EGP';
const REQUEST_TIMEOUT_MS = 15_000;

@Injectable()
export class PaymobGateway implements PaymentGateway {
  public readonly name = 'paymob';

  private readonly logger = new Logger(PaymobGateway.name);
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly integrationId: string;
  private readonly iframeId: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly expectedLive: boolean;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('PAYMOB_API_KEY') ?? '';
    this.secretKey = this.config.get<string>('PAYMOB_SECRET_KEY') ?? '';
    this.integrationId = this.config.get<string>('PAYMOB_CARD_INTEGRATION_ID') ?? '';
    this.iframeId = this.config.get<string>('PAYMOB_IFRAME_ID') ?? '';
    this.webhookSecret = this.config.get<string>('PAYMOB_WEBHOOK_SECRET') ?? '';
    this.baseUrl = (this.config.get<string>('PAYMOB_BASE_URL') ?? '').replace(/\/+$/u, '');
    validatePaymobBaseUrl(this.baseUrl);
    this.apiBaseUrl = this.baseUrl.endsWith('/api') ? this.baseUrl : `${this.baseUrl}/api`;
    const configuredMode = this.config.get<'test' | 'live'>('PAYMOB_EXPECTED_MODE');
    this.expectedLive =
      configuredMode === 'live' ||
      (configuredMode === undefined && this.config.get<string>('NODE_ENV') === 'production');
  }

  public async createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutResult> {
    this.assertConfigured();
    if (input.currency.toUpperCase() !== CURRENCY) {
      throw new InternalServerErrorException(
        biBody(
          'Payment currency is not supported',
          '\u0639\u0645\u0644\u0629 \u0627\u0644\u062f\u0641\u0639 \u063a\u064a\u0631 \u0645\u062f\u0639\u0648\u0645\u0629',
        ),
      );
    }

    const authToken = await this.getAuthToken();
    const providerOrderId = await this.registerOrder(authToken, input.amountMinor, input.paymentId);
    const paymentKey = await this.getPaymentKey(
      authToken,
      input.amountMinor,
      providerOrderId,
      input,
    );
    return this.checkoutResult(input.paymentId, providerOrderId, paymentKey);
  }

  public async createCheckoutOrder(input: ProviderCheckoutInput): Promise<string> {
    this.assertConfigured();
    if (input.currency.toUpperCase() !== CURRENCY) {
      throw new InternalServerErrorException(
        biBody('Payment currency is not supported', 'عملة الدفع غير مدعومة'),
      );
    }

    const authToken = await this.getAuthToken();
    const providerOrderId = await this.registerOrder(authToken, input.amountMinor, input.paymentId);
    return String(providerOrderId);
  }

  public async createCheckoutSession(
    input: ProviderCheckoutInput,
    providerReference: string,
  ): Promise<ProviderCheckoutResult> {
    this.assertConfigured();
    if (input.currency.toUpperCase() !== CURRENCY) {
      throw new InternalServerErrorException(
        biBody('Payment currency is not supported', 'Ø¹Ù…Ù„Ø© Ø§Ù„Ø¯ÙØ¹ ØºÙŠØ± Ù…Ø¯Ø¹ÙˆÙ…Ø©'),
      );
    }
    const providerOrderId = this.parsePositiveInteger(providerReference);
    if (providerOrderId === null) {
      throw this.unavailable('provider order reference is invalid');
    }

    const authToken = await this.getAuthToken();
    const paymentKey = await this.getPaymentKey(
      authToken,
      input.amountMinor,
      providerOrderId,
      input,
    );
    return this.checkoutResult(input.paymentId, providerOrderId, paymentKey);
  }

  public async getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus | null> {
    this.assertConfigured();
    if (!this.isPositiveIntegerString(providerReference)) return null;
    const authToken = await this.getAuthToken();
    const response = await this.request(
      `${this.apiBaseUrl}/ecommerce/orders/${encodeURIComponent(providerReference)}` +
        `?token=${encodeURIComponent(authToken)}`,
      { method: 'GET' },
      'payment status inquiry',
    );
    const data = (await response.json()) as PaymobOrderResponse;
    const amountMinor = this.optionalNonNegativeInteger(data.amount_cents);
    const paidMinor = this.optionalNonNegativeInteger(data.paid_amount_cents) ?? 0;
    const refundedMinor = this.optionalNonNegativeInteger(data.refunded_amount_cents) ?? 0;
    const currency = typeof data.currency === 'string' ? data.currency.toUpperCase() : undefined;
    const providerStatus =
      typeof data.payment_status === 'string' ? data.payment_status.toUpperCase() : '';

    let status: ProviderPaymentStatus['status'] = 'pending';
    if (amountMinor !== undefined && amountMinor > 0 && refundedMinor >= amountMinor) {
      status = 'refunded';
    } else if (amountMinor !== undefined && amountMinor > 0 && paidMinor >= amountMinor) {
      status = 'succeeded';
    } else if (
      ['FAILED', 'DECLINED', 'CANCELED', 'CANCELLED', 'EXPIRED'].includes(providerStatus)
    ) {
      status = 'failed';
    }
    return {
      status,
      ...(amountMinor === undefined ? {} : { amountMinor }),
      ...(currency === undefined ? {} : { currency }),
      providerReference,
    };
  }

  /**
   * Paymob's transaction-inquiry endpoint resolves a gateway order to its
   * actual transaction record. Recovery must use this record rather than
   * treating the Paymob order ID as a transaction ID.
   */
  public async getTransactionByOrderReference(
    providerOrderReference: string,
    merchantReference: string,
  ): Promise<ProviderTransactionDetails | null> {
    this.assertConfigured();
    const providerOrderId = this.parsePositiveInteger(providerOrderReference);
    if (providerOrderId === null || merchantReference === '') return null;
    const authToken = await this.getAuthToken();
    const response = await this.request(
      `${this.apiBaseUrl}/ecommerce/orders/transaction_inquiry`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_token: authToken,
          merchant_order_id: merchantReference,
          order_id: providerOrderId,
        }),
      },
      'transaction inquiry',
    );
    const data = (await response.json()) as PaymobTransactionInquiryResponse;
    const transactionId = this.parseUnknownPositiveInteger(data.id);
    const amountMinor = this.optionalNonNegativeInteger(data.amount_cents);
    const currency = typeof data.currency === 'string' ? data.currency.toUpperCase() : null;
    const responseOrderId = this.parseUnknownPositiveInteger(data.order?.id);
    const responseMerchantReference = data.order?.merchant_order_id;
    const timestamp = this.parseProviderTimestamp(data.updated_at ?? data.created_at);
    if (
      transactionId === null ||
      amountMinor === undefined ||
      currency === null ||
      responseOrderId === null ||
      responseMerchantReference !== merchantReference ||
      timestamp === null
    ) {
      return null;
    }
    const refundedAmountMinor = this.optionalNonNegativeInteger(data.refunded_amount_cents) ?? 0;
    this.assertProviderMode(data.is_live);
    const status: ProviderTransactionDetails['status'] =
      data.is_refunded === true || refundedAmountMinor >= amountMinor
        ? 'refunded'
        : data.success === true && data.pending !== true && data.error_occured !== true
          ? 'succeeded'
          : data.pending === true
            ? 'pending'
            : 'failed';
    return {
      transactionId,
      status,
      amountMinor,
      currency,
      occurredAt: timestamp,
      providerOrderReference: responseOrderId,
      merchantReference,
      refundedAmountMinor,
      ...(typeof data.is_live === 'boolean' ? { isLive: data.is_live } : {}),
    };
  }

  public async refund(input: ProviderRefundInput): Promise<ProviderRefundResult> {
    this.assertConfigured();
    if (input.currency.toUpperCase() !== CURRENCY || input.amountMinor <= 0) {
      throw new InternalServerErrorException(
        biBody('Refund amount or currency is invalid', 'مبلغ أو عملة الاسترداد غير صالح'),
      );
    }
    if (!this.isPositiveIntegerString(input.providerReference)) {
      throw new InternalServerErrorException(
        biBody('Payment cannot be refunded automatically', 'لا يمكن استرداد عملية الدفع آلياً'),
      );
    }

    const authToken = await this.getAuthToken();
    const response = await this.request(
      `${this.apiBaseUrl}/acceptance/void_refund/refund`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          auth_token: authToken,
          transaction_id: Number(input.providerReference),
          amount_cents: input.amountMinor,
        }),
      },
      'refund',
    );
    const data = (await response.json()) as PaymobRefundResponse;
    const refundReference =
      typeof data.id === 'number' && Number.isSafeInteger(data.id)
        ? String(data.id)
        : input.providerReference;
    const succeeded = data.is_refund === true || data.is_refunded === true || data.success === true;
    return {
      providerReference: refundReference,
      status: succeeded ? 'succeeded' : 'processing',
    };
  }

  public verifyWebhook(request: ProviderWebhookRequest): boolean {
    if (this.webhookSecret === '') {
      this.logger.error('Payment webhook secret is not configured; rejecting webhook');
      return false;
    }
    try {
      const webhook = parsePaymobWebhook(request);
      const calculated = crypto
        .createHmac('sha512', this.webhookSecret)
        .update(paymobHmacContent(webhook.transaction))
        .digest('hex');
      return this.safeCompare(calculated, webhook.signature.toLowerCase());
    } catch {
      return false;
    }
  }

  public parseWebhook(request: ProviderWebhookRequest): ProviderWebhookEvent {
    const integrationId = this.parsePositiveInteger(this.integrationId);
    if (integrationId === null) {
      throw new InternalServerErrorException(
        biBody('Payment service unavailable', 'خدمة الدفع غير متاحة حالياً'),
      );
    }
    const event = mapPaymobWebhook(parsePaymobWebhook(request), this.name, integrationId);
    this.assertProviderMode(event.isLive);
    return event;
  }

  private assertProviderMode(value: unknown): void {
    if (typeof value !== 'boolean' || value !== this.expectedLive) {
      throw new BadRequestException(
        'Payment gateway transaction mode does not match the configured environment',
      );
    }
  }

  public getConfigurationStatus(): PaymentGatewayConfigurationStatus {
    const settings = [
      this.apiKey,
      this.secretKey,
      this.integrationId,
      this.iframeId,
      this.webhookSecret,
      this.baseUrl,
    ];
    return {
      enabled: settings.some((value) => value !== ''),
      configured:
        settings.every((value) => value !== '') &&
        this.parsePositiveInteger(this.integrationId) !== null &&
        this.parsePositiveInteger(this.iframeId) !== null,
      endpoint: this.baseUrl,
    };
  }

  public supportsRefunds(): boolean {
    return true;
  }

  public supportsPayouts(): boolean {
    return false;
  }

  public supportsSplitSettlement(): boolean {
    return false;
  }

  private checkoutResult(
    paymentId: string,
    providerOrderId: number,
    paymentKey: string,
  ): ProviderCheckoutResult {
    const redirectUrl =
      `${this.apiBaseUrl}/acceptance/iframes/${encodeURIComponent(this.iframeId)}` +
      `?payment_token=${encodeURIComponent(paymentKey)}`;
    this.logger.log(`Gateway checkout created for payment ${paymentId}`);
    return {
      redirectUrl,
      providerReference: String(providerOrderId),
    };
  }

  private async getAuthToken(): Promise<string> {
    const response = await this.request(
      `${this.apiBaseUrl}/auth/tokens`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: this.apiKey }),
      },
      'authentication',
    );
    const data = (await response.json()) as PaymobAuthResponse;
    if (typeof data.token !== 'string' || data.token === '') {
      throw this.unavailable('authentication response was invalid');
    }
    return data.token;
  }

  private async registerOrder(
    authToken: string,
    amountMinor: number,
    merchantReference: string,
  ): Promise<number> {
    const response = await this.request(
      `${this.apiBaseUrl}/ecommerce/orders`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_token: authToken,
          delivery_needed: false,
          amount_cents: amountMinor,
          currency: CURRENCY,
          merchant_order_id: merchantReference,
          items: [],
        }),
      },
      'order registration',
    );
    const data = (await response.json()) as PaymobOrderResponse;
    if (typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id <= 0) {
      throw this.unavailable('order registration response was invalid');
    }
    return data.id;
  }

  private async getPaymentKey(
    authToken: string,
    amountMinor: number,
    providerOrderId: number,
    input: ProviderCheckoutInput,
  ): Promise<string> {
    const integrationId = this.parsePositiveInteger(this.integrationId);
    if (integrationId === null) throw this.unavailable('card integration is invalid');
    const billing = input.billingData;
    const response = await this.request(
      `${this.apiBaseUrl}/acceptance/payment_keys`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_token: authToken,
          amount_cents: amountMinor,
          expiration: 3600,
          order_id: providerOrderId,
          billing_data: {
            first_name: billing.first_name,
            last_name: billing.last_name,
            email: billing.email,
            phone_number: billing.phone_number,
            building: billing.building ?? 'NA',
            street: billing.street ?? 'NA',
            floor: billing.floor ?? 'NA',
            apartment: billing.apartment ?? 'NA',
            city: billing.city,
            state: billing.state,
            country: billing.country,
            postal_code: billing.postal_code ?? 'NA',
            shipping_method: 'NA',
          },
          currency: CURRENCY,
          integration_id: integrationId,
          lock_order_when_paid: true,
        }),
      },
      'payment key generation',
    );
    const data = (await response.json()) as PaymobPaymentKeyResponse;
    if (typeof data.token !== 'string' || data.token === '') {
      throw this.unavailable('payment key response was invalid');
    }
    return data.token;
  }

  private async request(url: string, init: RequestInit, operation: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw this.unavailable(`${operation} endpoint was unreachable`);
    }
    if (!response.ok) {
      this.logger.error(
        `Payment gateway ${operation} failed with status ${String(response.status)}`,
      );
      throw this.unavailable(`${operation} failed`);
    }
    return response;
  }

  private assertConfigured(): void {
    if (!this.getConfigurationStatus().configured) {
      throw this.unavailable('configuration is incomplete');
    }
  }

  private unavailable(reason: string): InternalServerErrorException {
    this.logger.error(`Payment gateway unavailable: ${reason}`);
    return new InternalServerErrorException(
      biBody('Payment service unavailable', 'خدمة الدفع غير متاحة حالياً'),
    );
  }

  private parsePositiveInteger(value: string): number | null {
    if (!/^\d+$/u.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  private parseUnknownPositiveInteger(value: unknown): string | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : null;
  }

  private parseProviderTimestamp(value: unknown): Date | null {
    if (typeof value !== 'string') return null;
    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  }

  private isPositiveIntegerString(value: string): boolean {
    return this.parsePositiveInteger(value) !== null;
  }

  private optionalNonNegativeInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  }

  private safeCompare(expected: string, received: string): boolean {
    if (received === '') return false;
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const receivedBuffer = Buffer.from(received, 'utf8');
    return (
      expectedBuffer.length === receivedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
    );
  }
}
