import * as crypto from 'node:crypto';

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { biBody } from '../../i18n/error-translator.util';
import { BillingDataDto } from '../dto/billing-data.dto';
import { EasyKashWebhookDto } from '../dto/easykash-webhook.dto';
import { fromMinorUnits } from '../money.util';
import type {
  PaymentProvider,
  ProviderCheckoutInput,
  ProviderCheckoutResult,
  ProviderPaymentStatus,
  ProviderRefundInput,
  ProviderRefundResult,
} from '../providers/payment-provider.interface';

/*
 * EasyKash payment provider. Implemented strictly from the official docs:
 *   - direct-payment-hosted/pay-api
 *   - direct-payment-hosted/callback-service
 *   - direct-payment-hosted/callback-service/callback-response-verification
 *
 * Exposes the same surface the payments module already depends on
 * (initiatePayment + verifyHmac) so no business logic, purchase flow, DB schema,
 * status, or frontend response shape changes when swapping from Paymob.
 */

/** Create-payment endpoint path (docs: pay-api). Relative to EASYKASH_API_URL. */
const CREATE_PAYMENT_PATH = '/api/directpayv1/pay';

/** Payment currency. The platform only ever charges in EGP. */
const CURRENCY = 'EGP';

@Injectable()
export class EasyKashService implements PaymentProvider {
  private readonly logger = new Logger(EasyKashService.name);
  private readonly apiKey: string;
  private readonly hmacSecret: string;
  private readonly apiUrl: string;
  private readonly frontendUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('EASYKASH_API_KEY') ?? '';
    this.hmacSecret = this.configService.get<string>('EASYKASH_HMAC_SECRET') ?? '';
    this.apiUrl = (this.configService.get<string>('EASYKASH_API_URL') ?? '').replace(/\/+$/, '');
    // Browser return destination after checkout (EasyKash appends ?status=...).
    this.frontendUrl = (this.configService.get<string>('FRONTEND_URL') ?? '').replace(/\/+$/, '');
  }

  public readonly name = 'easykash';

  public async createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutResult> {
    if (input.currency !== CURRENCY) {
      throw new InternalServerErrorException(
        biBody('Payment currency is not supported', 'عملة الدفع غير مدعومة'),
      );
    }
    const result = await this.initiatePayment(
      fromMinorUnits(input.amountMinor),
      input.paymentId,
      input.billingData,
    );
    return {
      redirectUrl: result.redirectUrl,
      providerReference: result.providerReference === '' ? null : result.providerReference,
    };
  }

  public async getPaymentStatus(_providerReference: string): Promise<ProviderPaymentStatus | null> {
    // EasyKash inquiry is not enabled for this integration. Reconciliation
    // reports the attempt as unresolved instead of fabricating provider state.
    return null;
  }

  public async refund(_input: ProviderRefundInput): Promise<ProviderRefundResult> {
    throw new InternalServerErrorException(
      biBody(
        'Automatic refunds are not supported by the configured provider',
        'الاسترداد الآلي غير مدعوم من مزود الدفع الحالي',
      ),
    );
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

  /**
   * Create a hosted-checkout payment (docs: pay-api) and return the URL to
   * redirect the buyer to. `merchantOrderId` is our `payment.id`; EasyKash echoes
   * it back on the callback as `customerReference` so we can reconcile.
   *
   * Amount is sent in major units of the currency (e.g. 50.5 EGP), per the docs
   * ("Base amount in the specified currency", not piastres).
   *
   * Returns a provider-neutral shape; the caller maps `redirectUrl` into the
   * unchanged `PaymentResponse.iframe_url`. EasyKash does not return a
   * transaction reference at creation (only `redirectUrl`), so `providerReference`
   * is empty here — the real reference (`easykashRef`) arrives on the callback.
   */
  public async initiatePayment(
    amount: number,
    merchantOrderId: string,
    billingData: BillingDataDto,
  ): Promise<{ redirectUrl: string; providerReference: string }> {
    if (this.apiUrl === '' || this.apiKey === '') {
      this.logger.error('EasyKash is not configured (EASYKASH_API_URL / EASYKASH_API_KEY missing)');
      throw new InternalServerErrorException(
        biBody('Payment service unavailable', 'خدمة الدفع غير متاحة حاليًا'),
      );
    }

    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}${CREATE_PAYMENT_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Docs: authentication is the raw API key in the `authorization` header.
          authorization: this.apiKey,
        },
        body: JSON.stringify({
          amount,
          currency: CURRENCY,
          name: `${billingData.first_name} ${billingData.last_name}`.trim(),
          email: billingData.email,
          mobile: billingData.phone_number,
          // Required by the API. EasyKash returns the buyer here after checkout.
          redirectUrl: this.buildRedirectUrl(),
          // Our payment.id — echoed back on the callback for reconciliation.
          customerReference: merchantOrderId,
        }),
      });
    } catch (error) {
      this.logger.error('Failed to reach EasyKash create-payment endpoint', error);
      throw new InternalServerErrorException(
        biBody('Payment service unavailable', 'خدمة الدفع غير متاحة حاليًا'),
      );
    }

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(`EasyKash create-payment failed (${response.status}): ${errorBody}`);
      throw new InternalServerErrorException(
        biBody('Failed to initiate payment', 'فشل بدء عملية الدفع'),
      );
    }

    const data = (await response.json()) as { redirectUrl?: unknown };

    if (typeof data.redirectUrl !== 'string' || data.redirectUrl === '') {
      this.logger.error(
        `EasyKash create-payment response missing redirectUrl: ${JSON.stringify(data)}`,
      );
      throw new InternalServerErrorException(
        biBody('Failed to initiate payment', 'فشل بدء عملية الدفع'),
      );
    }

    this.logger.log(`Payment initiated for order ${merchantOrderId}`);
    return { redirectUrl: data.redirectUrl, providerReference: '' };
  }

  /**
   * Verify the HMAC signature on an EasyKash callback. Per the docs
   * (callback-response-verification): HMAC-SHA512 over the concatenation (no
   * separators) of ProductCode + Amount + ProductType + PaymentMethod + status +
   * easykashRef + customerReference, hex digest, compared to `signatureHash`.
   *
   * Fails closed on any misconfiguration or mismatch. Uses constant-time
   * comparison (stronger than the docs' `===` example, same result).
   */
  public verifyHmac(payload: EasyKashWebhookDto, receivedHmac: string): boolean {
    // Never accept unsigned data — reject if the secret is not configured.
    if (this.hmacSecret === '') {
      this.logger.error('EASYKASH_HMAC_SECRET is not configured — rejecting callback');
      return false;
    }

    // Exact field order from the docs; values used raw as received.
    const dataStr =
      payload.ProductCode +
      payload.Amount +
      payload.ProductType +
      payload.PaymentMethod +
      payload.status +
      payload.easykashRef +
      payload.customerReference;

    const calculatedSignature = crypto
      .createHmac('sha512', this.hmacSecret)
      .update(dataStr)
      .digest('hex');

    const isValid = this.safeCompare(calculatedSignature, receivedHmac);
    if (!isValid) {
      this.logger.warn(`HMAC verification failed for EasyKash ref ${payload.easykashRef}`);
    }
    return isValid;
  }

  /** Browser return URL sent as `redirectUrl` on create-payment. */
  private buildRedirectUrl(): string {
    // Falls back to the API host only if FRONTEND_URL is unset; EasyKash requires
    // a non-empty redirectUrl. The chosen path is a product decision — it lands
    // the buyer on their purchases page after checkout.
    const base = this.frontendUrl !== '' ? this.frontendUrl : this.apiUrl;
    return `${base}/student/payments`;
  }

  /**
   * Constant-time comparison to prevent timing side-channel attacks on HMAC
   * verification. Returns false on any length mismatch or invalid input.
   */
  private safeCompare(expected: string, received: unknown): boolean {
    if (typeof received !== 'string' || received.length === 0) {
      return false;
    }
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }
}
