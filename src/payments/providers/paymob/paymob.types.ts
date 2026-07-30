export interface PaymobSourceData {
  pan: string;
  subType: string;
  type: string;
}

export interface PaymobOrderReference {
  id: number;
  merchantOrderId: string;
}

export interface PaymobTransaction {
  id: number;
  amountMinor: number;
  currency: string;
  success: boolean;
  pending: boolean;
  errorOccurred: boolean;
  is3dSecure: boolean;
  isAuth: boolean;
  isCapture: boolean;
  isRefunded: boolean;
  isVoided: boolean;
  isStandalonePayment: boolean;
  hasParentTransaction: boolean;
  integrationId: number;
  owner: number;
  createdAt: string;
  sourceData: PaymobSourceData;
  order: PaymobOrderReference;
  message?: string;
}

export interface PaymobWebhookData {
  type: string;
  signature: string;
  transaction: PaymobTransaction;
}

export interface PaymobAuthResponse {
  token?: unknown;
}

export interface PaymobOrderResponse {
  id?: unknown;
  amount_cents?: unknown;
  currency?: unknown;
  paid_amount_cents?: unknown;
  refunded_amount_cents?: unknown;
  payment_status?: unknown;
}

export interface PaymobTransactionInquiryResponse {
  id?: unknown;
  amount_cents?: unknown;
  currency?: unknown;
  success?: unknown;
  pending?: unknown;
  error_occured?: unknown;
  is_refunded?: unknown;
  is_voided?: unknown;
  refunded_amount_cents?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  order?: {
    id?: unknown;
    merchant_order_id?: unknown;
  };
}

export interface PaymobPaymentKeyResponse {
  token?: unknown;
}

export interface PaymobRefundResponse {
  id?: unknown;
  success?: unknown;
  is_refund?: unknown;
  is_refunded?: unknown;
  pending?: unknown;
}
