import type { BillingDataDto } from '../dto/billing-data.dto';

export interface ProviderCheckoutInput {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  amountMinor: number;
  currency: string;
  billingData: BillingDataDto;
}

export interface ProviderCheckoutResult {
  redirectUrl: string;
  providerReference: string | null;
}

export interface ProviderRefundInput {
  providerReference: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}

export interface ProviderRefundResult {
  providerReference: string;
  status: 'processing' | 'succeeded';
}

export interface ProviderPaymentStatus {
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  amountMinor?: number;
  currency?: string;
  providerReference?: string;
}

/**
 * Domain-facing provider contract. Commission, wallets and settlements never
 * depend on these capabilities; a provider only moves/validates external cash.
 */
export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutResult>;
  getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus | null>;
  refund(input: ProviderRefundInput): Promise<ProviderRefundResult>;
  supportsRefunds(): boolean;
  supportsPayouts(): boolean;
  supportsSplitSettlement(): boolean;
}
