import type { BillingDataDto } from '../dto/billing-data.dto';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

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

export interface ProviderWebhookRequest {
  payload: unknown;
  signature?: string;
}

export interface ProviderWebhookEvent {
  provider: string;
  providerEventId: string;
  merchantReference: string;
  providerOrderReference: string;
  transactionId: string;
  amountMinor: number;
  currency: string;
  outcome: 'pending' | 'succeeded' | 'failed' | 'refunded';
  message?: string;
  payload: Record<string, unknown>;
}

export interface PaymentGatewayConfigurationStatus {
  enabled: boolean;
  configured: boolean;
  endpoint: string;
}

/**
 * Domain-facing provider contract. Commission, wallets and settlements never
 * depend on these capabilities; a gateway only moves and validates external
 * cash. Provider-specific DTOs and states must be normalized before crossing
 * this boundary.
 */
export interface PaymentGateway {
  readonly name: string;
  createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutResult>;
  getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus | null>;
  refund(input: ProviderRefundInput): Promise<ProviderRefundResult>;
  verifyWebhook(request: ProviderWebhookRequest): boolean;
  parseWebhook(request: ProviderWebhookRequest): ProviderWebhookEvent;
  getConfigurationStatus(): PaymentGatewayConfigurationStatus;
  supportsRefunds(): boolean;
  supportsPayouts(): boolean;
  supportsSplitSettlement(): boolean;
}
