import * as crypto from 'node:crypto';

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { biBody } from '../../../i18n/error-translator.util';
import type {
  PaymentGateway,
  PaymentGatewayConfigurationStatus,
  ProviderCheckoutInput,
  ProviderCheckoutResult,
  ProviderRefundInput,
  ProviderRefundResult,
  ProviderTransactionDetails,
  ProviderWebhookEvent,
  ProviderWebhookRequest,
} from '../payment-gateway.interface';
import {
  easyKashHmacContent,
  mapEasyKashWebhook,
  parseEasyKashAmountMinor,
  parseEasyKashWebhook,
} from './easykash.mapper';
import type { EasyKashInquiryResponse, EasyKashPayResponse } from './easykash.types';

const CURRENCY = 'EGP';
const REQUEST_TIMEOUT_MS = 15_000;
const HOSTED_HOST = 'www.easykash.net';
const HOSTED_PATH = /^\/DirectPayV1\/([A-Za-z0-9]{3,64})$/u;
/** Documented Pay API option ids that settle by cash voucher (Aman, Fawry). */
const CASH_OPTIONS: ReadonlySet<number> = new Set([1, 5]);
const DEFAULT_PAYMENT_OPTIONS = [2, 4, 6, 31, 35, 1, 5];
const DEFAULT_CASH_EXPIRY_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class EasyKashGateway implements PaymentGateway {
  public readonly name = 'easykash';

  private readonly logger = new Logger(EasyKashGateway.name);
  private readonly apiKey: string;
  private readonly hmacSecret: string;
  private readonly baseUrl: string;
  private readonly backendUrl: string;
  private readonly paymentOptions: number[];
  private readonly cashExpiryHours: number;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('EASYKASH_API_KEY') ?? '';
    this.hmacSecret = this.config.get<string>('EASYKASH_HMAC_SECRET') ?? '';
    this.baseUrl = (this.config.get<string>('EASYKASH_API_BASE_URL') ?? 'https://back.easykash.net')
      .trim()
      .replace(/\/+$/u, '');
    this.backendUrl = (this.config.get<string>('BACKEND_URL') ?? '').trim().replace(/\/+$/u, '');
    this.paymentOptions = parseOptionList(this.config.get<string>('EASYKASH_PAYMENT_OPTIONS'));
    const hours = Number(this.config.get<string>('EASYKASH_CASH_EXPIRY_HOURS'));
    this.cashExpiryHours =
      Number.isInteger(hours) && hours >= 1 && hours <= 72 ? hours : DEFAULT_CASH_EXPIRY_HOURS;
  }

  /**
   * Creates the hosted payment link. EasyKash has no separate "order" step, so
   * the hosted product code is the provider order reference. The caller
   * persists it before the link is ever returned to a customer.
   */
  public async createCheckoutOrder(input: ProviderCheckoutInput): Promise<string> {
    this.assertConfigured();
    if (input.currency.toUpperCase() !== CURRENCY) {
      throw new InternalServerErrorException(
        biBody('Payment currency is not supported', 'عملة الدفع غير مدعومة'),
      );
    }
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw this.unavailable('amount is invalid');
    }
    const { options, cashExpiry } = this.resolveMethods(input.expiresAt);
    const billing = input.billingData;
    const response = await this.request(
      `${this.baseUrl}/api/directpayv1/pay`,
      {
        amount: Number((input.amountMinor / 100).toFixed(2)),
        currency: CURRENCY,
        paymentOptions: options,
        ...(cashExpiry === null ? {} : { cashExpiry }),
        name: `${billing.first_name} ${billing.last_name}`.trim(),
        email: billing.email,
        mobile: billing.phone_number,
        redirectUrl: `${this.backendUrl}/api/v1/payments/easykash/return/${input.paymentId}`,
        customerReference: input.paymentId,
      },
      'payment creation',
    );
    const data = (await response.json().catch(() => ({}))) as EasyKashPayResponse;
    const productCode = this.parseHostedProductCode(data.redirectUrl);
    if (productCode === null) throw this.unavailable('payment creation response was invalid');
    this.logger.log(`Gateway checkout created for payment ${input.paymentId}`);
    return productCode;
  }

  /** No network call: the hosted link is derived from the stored product code. */
  public createCheckoutSession(
    _input: ProviderCheckoutInput,
    providerReference: string,
  ): Promise<ProviderCheckoutResult> {
    this.assertConfigured();
    if (!/^[A-Za-z0-9]{3,64}$/u.test(providerReference)) {
      return Promise.reject(this.unavailable('provider order reference is invalid'));
    }
    return Promise.resolve({
      redirectUrl: `https://${HOSTED_HOST}/DirectPayV1/${providerReference}`,
      providerReference,
    });
  }

  public async getTransactionByOrderReference(
    providerOrderReference: string,
    merchantReference: string,
  ): Promise<ProviderTransactionDetails | null> {
    this.assertConfigured();
    if (providerOrderReference === '' || merchantReference === '') return null;
    const response = await this.request(
      `${this.baseUrl}/api/cash-api/inquire`,
      { customerReference: merchantReference },
      'payment inquiry',
    );
    const data = (await response.json().catch(() => null)) as EasyKashInquiryResponse | null;
    if (data === null || typeof data !== 'object') return null;
    const amountMinor = parseEasyKashAmountMinor(data.Amount);
    const status = typeof data.status === 'string' ? data.status.toUpperCase() : '';
    const transactionId =
      typeof data.easykashRef === 'string' || typeof data.easykashRef === 'number'
        ? String(data.easykashRef)
        : '';
    if (amountMinor === null || status === '') return null;

    let mapped: ProviderTransactionDetails['status'];
    if (status === 'PAID' || status === 'DELIVERED') mapped = 'succeeded';
    else if (status === 'REFUNDED') mapped = 'refunded';
    else if (['FAILED', 'EXPIRED', 'CANCELED', 'CANCELLED'].includes(status)) mapped = 'failed';
    else if (status === 'NEW') mapped = 'pending';
    else return null;
    // A paid/refunded state without a transaction reference cannot be applied.
    if ((mapped === 'succeeded' || mapped === 'refunded') && transactionId === '') return null;

    return {
      transactionId,
      status: mapped,
      amountMinor,
      currency: CURRENCY,
      providerOrderReference,
      merchantReference,
      refundedAmountMinor: mapped === 'refunded' ? amountMinor : 0,
    };
  }

  public refund(_input: ProviderRefundInput): Promise<ProviderRefundResult> {
    return Promise.reject(
      new InternalServerErrorException(
        biBody(
          'Payment cannot be refunded automatically; refund it in the gateway dashboard',
          'لا يمكن استرداد عملية الدفع آلياً، يرجى الاسترداد من لوحة بوابة الدفع',
        ),
      ),
    );
  }

  public verifyWebhook(request: ProviderWebhookRequest): boolean {
    if (this.hmacSecret === '') {
      this.logger.error('Payment webhook secret is not configured; rejecting webhook');
      return false;
    }
    try {
      const webhook = parseEasyKashWebhook(request);
      const calculated = crypto
        .createHmac('sha512', this.hmacSecret)
        .update(easyKashHmacContent(webhook.signed))
        .digest('hex');
      return this.safeCompare(calculated, webhook.signatureHash);
    } catch {
      return false;
    }
  }

  public parseWebhook(request: ProviderWebhookRequest): ProviderWebhookEvent {
    return mapEasyKashWebhook(parseEasyKashWebhook(request), this.name);
  }

  public getConfigurationStatus(): PaymentGatewayConfigurationStatus {
    const settings = [this.apiKey, this.hmacSecret, this.baseUrl, this.backendUrl];
    return {
      enabled: settings.some((value) => value !== ''),
      configured: settings.every((value) => value !== ''),
      endpoint: this.baseUrl,
    };
  }

  public supportsRefunds(): boolean {
    return false;
  }

  public supportsPayouts(): boolean {
    return false;
  }

  public supportsSplitSettlement(): boolean {
    return false;
  }

  /** Cash vouchers are only offered when the order stays open long enough to be paid. */
  private resolveMethods(expiresAt: Date | undefined): {
    options: number[];
    cashExpiry: number | null;
  } {
    const remainingMs = expiresAt === undefined ? Infinity : expiresAt.getTime() - Date.now();
    const cashAllowed = remainingMs >= HOUR_MS;
    const options = this.paymentOptions.filter((id) => cashAllowed || !CASH_OPTIONS.has(id));
    if (options.length === 0) throw this.unavailable('no payment option is available');
    if (!options.some((id) => CASH_OPTIONS.has(id))) return { options, cashExpiry: null };
    const hoursLeft = Number.isFinite(remainingMs) ? Math.floor(remainingMs / HOUR_MS) : Infinity;
    return { options, cashExpiry: Math.max(1, Math.min(this.cashExpiryHours, hoursLeft)) };
  }

  private parseHostedProductCode(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.hostname.toLowerCase() !== HOSTED_HOST ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== '' ||
        url.port !== ''
      ) {
        return null;
      }
      return HOSTED_PATH.exec(url.pathname)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  private async request(url: string, body: unknown, operation: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: this.apiKey },
        body: JSON.stringify(body),
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

function parseOptionList(value: string | undefined): number[] {
  if (value === undefined || value.trim() === '') return DEFAULT_PAYMENT_OPTIONS;
  const ids = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
  return ids.length > 0 ? ids : DEFAULT_PAYMENT_OPTIONS;
}
