import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  ValidateNested,
  IsBoolean,
  IsNumber,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PaymobSourceDataDto {
  @ApiProperty({ description: 'Card PAN (masked)' })
  @IsString()
  pan!: string;

  @ApiProperty({ description: 'Payment sub type' })
  @IsString()
  sub_type!: string;

  @ApiProperty({ description: 'Payment type' })
  @IsString()
  type!: string;
}

export class PaymobOrderDto {
  @ApiProperty({ description: 'Paymob order ID' })
  @IsNumber()
  id!: number;

  @ApiProperty({ description: 'Merchant order ID (our payment.id)' })
  @IsString()
  merchant_order_id!: string;
}

export class PaymobTransactionDto {
  @ApiProperty({ description: 'Transaction ID' })
  @IsNumber()
  id!: number;

  @ApiProperty({ description: 'Amount in cents' })
  @IsNumber()
  amount_cents!: number;

  @ApiProperty({ description: 'Currency' })
  @IsString()
  currency!: string;

  @ApiProperty({ description: 'Transaction success status' })
  @IsBoolean()
  success!: boolean;

  @ApiProperty({ description: 'Transaction pending status' })
  @IsBoolean()
  pending!: boolean;

  @ApiProperty({ description: 'Error occurred flag' })
  @IsBoolean()
  error_occured!: boolean;

  @ApiProperty({ description: 'Is 3D Secure' })
  @IsBoolean()
  is_3d_secure!: boolean;

  @ApiProperty({ description: 'Is auth transaction' })
  @IsBoolean()
  is_auth!: boolean;

  @ApiProperty({ description: 'Is capture transaction' })
  @IsBoolean()
  is_capture!: boolean;

  @ApiProperty({ description: 'Is refunded' })
  @IsBoolean()
  is_refunded!: boolean;

  @ApiProperty({ description: 'Is voided' })
  @IsBoolean()
  is_voided!: boolean;

  @ApiProperty({ description: 'Is standalone payment' })
  @IsBoolean()
  is_standalone_payment!: boolean;

  @ApiProperty({ description: 'Has parent transaction' })
  @IsBoolean()
  has_parent_transaction!: boolean;

  @ApiProperty({ description: 'Integration ID' })
  @IsNumber()
  integration_id!: number;

  @ApiProperty({ description: 'Owner ID' })
  @IsNumber()
  owner!: number;

  @ApiProperty({ description: 'Creation timestamp' })
  @IsString()
  created_at!: string;

  @ApiProperty({ description: 'Source data' })
  @ValidateNested()
  @Type(() => PaymobSourceDataDto)
  source_data!: PaymobSourceDataDto;

  @ApiProperty({ description: 'Order details' })
  @ValidateNested()
  @Type(() => PaymobOrderDto)
  order!: PaymobOrderDto;

  @ApiProperty({ description: 'Data message (error details)', required: false })
  @IsOptional()
  @IsString()
  data_message?: string;
}

export class PaymobWebhookDto {
  @ApiProperty({ description: 'Transaction object' })
  @ValidateNested()
  @Type(() => PaymobTransactionDto)
  obj!: PaymobTransactionDto;

  @ApiProperty({ description: 'HMAC signature for verification' })
  @IsString()
  @IsNotEmpty()
  hmac!: string;

  @ApiProperty({ description: 'Webhook type' })
  @IsString()
  type!: string;
}
