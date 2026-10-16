/** Direct Payment (Hosted) Pay API response. */
export interface EasyKashPayResponse {
  redirectUrl?: unknown;
}

/** Payment Inquiry API response (currency and ProductCode are not returned). */
export interface EasyKashInquiryResponse {
  PaymentMethod?: unknown;
  Amount?: unknown;
  status?: unknown;
  voucher?: unknown;
  easykashRef?: unknown;
}

/** The seven fields covered by the callback HMAC, in the documented order. */
export interface EasyKashSignedFields {
  ProductCode: string;
  Amount: string;
  ProductType: string;
  PaymentMethod: string;
  status: string;
  easykashRef: string;
  customerReference: string;
}

export interface EasyKashWebhookData {
  signed: EasyKashSignedFields;
  signatureHash: string;
  voucher?: string;
}
