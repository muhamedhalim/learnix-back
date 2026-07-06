import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/*
 * EasyKash callback (webhook) payload — per the official docs:
 *   direct-payment-hosted/callback-service
 *   direct-payment-hosted/callback-service/callback-response-verification
 *
 * All fields are received as-is from EasyKash. The seven fields used for HMAC
 * verification (ProductCode, Amount, ProductType, PaymentMethod, status,
 * easykashRef, customerReference) are kept as STRINGS so the exact received
 * representation is preserved for the signature check (e.g. Amount "1.00" must
 * not be reformatted to "1").
 */
export class EasyKashWebhookDto {
  @ApiProperty({ description: 'Product identifier (last part of product URL)' })
  @IsString()
  public ProductCode!: string;

  @ApiProperty({ description: 'Payment method, e.g. "Credit & Debit Card"' })
  @IsString()
  public PaymentMethod!: string;

  @ApiProperty({ description: 'Product type, e.g. "Direct Pay"' })
  @IsString()
  public ProductType!: string;

  @ApiProperty({ description: 'Payment amount as a numeric string, e.g. "50.5"' })
  @IsString()
  public Amount!: string;

  @ApiProperty({ description: 'Our payment.id, echoed back from create-payment' })
  @IsString()
  public customerReference!: string;

  @ApiProperty({ description: "EasyKash's payment reference number" })
  @IsString()
  public easykashRef!: string;

  @ApiProperty({ description: 'Payment status — the callback fires with "PAID"' })
  @IsString()
  public status!: string;

  @ApiProperty({ description: 'HMAC-SHA512 signature of the payload' })
  @IsNotEmpty()
  @IsString()
  public signatureHash!: string;

  @ApiPropertyOptional({ description: "Buyer's email" })
  @IsOptional()
  @IsString()
  public BuyerEmail?: string;

  @ApiPropertyOptional({ description: "Buyer's phone number" })
  @IsOptional()
  @IsString()
  public BuyerMobile?: string;

  @ApiPropertyOptional({ description: "Buyer's name" })
  @IsOptional()
  @IsString()
  public BuyerName?: string;

  @ApiPropertyOptional({ description: 'Unix timestamp of the callback' })
  @IsOptional()
  public Timestamp?: string | number;

  @ApiPropertyOptional({ description: 'Cash-payment voucher number (cash methods only)' })
  @IsOptional()
  @IsString()
  public voucher?: string;

  @ApiPropertyOptional({ description: 'Payment title' })
  @IsOptional()
  @IsString()
  public VoucherData?: string;
}
