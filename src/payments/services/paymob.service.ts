import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BillingDataDto } from '../dto/billing-data.dto';
import { PaymobTransactionDto } from '../dto/paymob-webhook.dto';
import * as crypto from 'crypto';

interface PaymobAuthResponse {
  token: string;
}

interface WebhookPayload {
  obj?: PaymobTransactionDto;
}

interface PaymobOrderResponse {
  id: number;
  created_at: string;
  delivery_needed: boolean;
  merchant: { id: number };
  amount_cents: number;
  currency: string;
}

interface PaymobPaymentKeyResponse {
  token: string;
}

@Injectable()
export class PaymobService {
  private readonly logger = new Logger(PaymobService.name);
  private readonly apiKey: string;
  private readonly integrationId: string;
  private readonly iframeId: string;
  private readonly hmacSecret: string;
  private readonly baseUrl = 'https://accept.paymob.com/api';

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('PAYMOB_API_KEY') ?? '';
    this.integrationId =
      this.configService.get<string>('PAYMOB_INTEGRATION_ID') ?? '';
    this.iframeId = this.configService.get<string>('PAYMOB_IFRAME_ID') ?? '';
    this.hmacSecret =
      this.configService.get<string>('PAYMOB_HMAC_SECRET') ?? '';
  }

  /**
   * Step 1: Get authentication token from Paymob
   */
  public async getAuthToken(): Promise<string> {
    try {
      const response = await fetch(`${this.baseUrl}/auth/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: this.apiKey }),
      });

      if(!response.ok) {
        const error = await response.text();
        this.logger.error(`Paymob auth failed: ${error}`);
        throw new InternalServerErrorException(
          'Payment service authentication failed',
        );
      }

      const data = (await response.json()) as PaymobAuthResponse;
      return data.token;
    } catch (error) {
      this.logger.error('Failed to get Paymob auth token', error);
      throw new InternalServerErrorException('Payment service unavailable');
    }
  }

  /**
   * Step 2: Register order with Paymob
   */
  public async registerOrder(
    authToken: string,
    amountCents: number,
    merchantOrderId: string,
  ): Promise<number> {
    try {
      const response = await fetch(`${this.baseUrl}/ecommerce/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          auth_token: authToken,
          delivery_needed: false,
          amount_cents: amountCents,
          currency: 'EGP',
          merchant_order_id: merchantOrderId,
          items: [],
        }),
      });

      if(!response.ok) {
        const error = await response.text();
        this.logger.error(`Paymob order registration failed: ${error}`);
        throw new InternalServerErrorException(
          'Failed to register payment order',
        );
      }

      const data = (await response.json()) as PaymobOrderResponse;
      return data.id;
    } catch (error) {
      this.logger.error('Failed to register Paymob order', error);
      throw new InternalServerErrorException(
        'Payment order registration failed',
      );
    }
  }

  /**
   * Step 3: Generate payment key for iframe
   */
  public async getPaymentKey(
    authToken: string,
    amountCents: number,
    orderId: number,
    billingData: BillingDataDto,
  ): Promise<string> {
    try {
      const response = await fetch(`${this.baseUrl}/acceptance/payment_keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          auth_token: authToken,
          amount_cents: amountCents,
          expiration: 3600, // 1 hour
          order_id: orderId,
          billing_data: {
            first_name: billingData.first_name,
            last_name: billingData.last_name,
            email: billingData.email,
            phone_number: billingData.phone_number,
            building: billingData.building ?? 'NA',
            street: billingData.street ?? 'NA',
            floor: billingData.floor ?? 'NA',
            apartment: billingData.apartment ?? 'NA',
            city: billingData.city,
            state: billingData.state,
            country: billingData.country,
            postal_code: billingData.postal_code ?? 'NA',
            shipping_method: 'NA',
          },
          currency: 'EGP',
          integration_id: parseInt(this.integrationId, 10),
        }),
      });

      if(!response.ok) {
        const error = await response.text();
        this.logger.error(`Paymob payment key generation failed: ${error}`);
        throw new InternalServerErrorException(
          'Failed to generate payment key',
        );
      }

      const data = (await response.json()) as PaymobPaymentKeyResponse;
      return data.token;
    } catch (error) {
      this.logger.error('Failed to get Paymob payment key', error);
      throw new InternalServerErrorException('Payment key generation failed');
    }
  }

  /**
   * Complete payment flow: auth -> order -> payment key
   */
  public async initiatePayment(
    amount: number,
    merchantOrderId: string,
    billingData: BillingDataDto,
  ): Promise<{ paymentKey: string; paymobOrderId: number; iframeUrl: string }> {
    const amountCents = Math.round(amount * 100);

    // Step 1: Authenticate
    const authToken = await this.getAuthToken();

    // Step 2: Register order
    const paymobOrderId = await this.registerOrder(
      authToken,
      amountCents,
      merchantOrderId,
    );

    // Step 3: Get payment key
    const paymentKey = await this.getPaymentKey(
      authToken,
      amountCents,
      paymobOrderId,
      billingData,
    );

    // Generate iframe URL
    const iframeUrl = `https://accept.paymob.com/api/acceptance/iframes/${this.iframeId}?payment_token=${paymentKey}`;

    this.logger.log(
      `Payment initiated for order ${merchantOrderId}, Paymob order ID: ${paymobOrderId.toString()}`,
    );

    return { paymentKey, paymobOrderId, iframeUrl };
  }

  /**
   * Verify HMAC signature from webhook
   * Critical security check to ensure webhook is from Paymob
   */
  public verifyHmac(
    webhookData: WebhookPayload | PaymobTransactionDto,
    receivedHmac: string,
  ): boolean {
    const obj: PaymobTransactionDto =
      (webhookData as WebhookPayload).obj ??
      (webhookData as PaymobTransactionDto);

    // Concatenate fields in the exact order Paymob specifies
    const hmacFields = [
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
      obj.order.id,
      obj.owner,
      obj.pending,
      obj.source_data.pan,
      obj.source_data.sub_type,
      obj.source_data.type,
      obj.success,
    ];

    const hmacString = hmacFields.join('');

    const calculatedHmac = crypto
      .createHmac('sha512', this.hmacSecret)
      .update(hmacString)
      .digest('hex');

    const isValid = calculatedHmac === receivedHmac;

    if(!isValid) {
      this.logger.warn(`HMAC verification failed for transaction ${obj.id.toString()}`);
      this.logger.debug(`Expected: ${calculatedHmac.substring(0, 20)}...`);
      this.logger.debug(`Received: ${receivedHmac.substring(0, 20)}...`);
    }

    return isValid;
  }

  /**
   * Get iframe ID for frontend redirect
   */
  public getIframeId(): string {
    return this.iframeId;
  }
}
