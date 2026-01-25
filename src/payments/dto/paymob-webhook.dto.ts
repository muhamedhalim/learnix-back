import { ApiProperty } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class PaymobSourceDataDto {
  @ApiProperty({ description: 'Card PAN (masked)' })
  @IsString()
  public pan!: string;

  @IsString()
  public sub_type!: string;

  @IsString()
  public type!: string;
}

export class PaymobOrderDto {
  @IsNumber()
  public id!: number;

  @ApiProperty({ description: 'Merchant order ID (our payment.id)' })
  @IsString()
  public merchant_order_id!: string;
}

export class PaymobTransactionDto {
  @IsNumber()
  public id!: number;

  @IsNumber()
  public amount_cents!: number;

  @IsString()
  public currency!: string;

  @IsBoolean()
  public success!: boolean;

  @IsBoolean()
  public pending!: boolean;

  @IsBoolean()
  public error_occured!: boolean;

  @IsBoolean()
  public is_3d_secure!: boolean;

  @IsBoolean()
  public is_auth!: boolean;

  @IsBoolean()
  public is_capture!: boolean;

  @IsBoolean()
  public is_refunded!: boolean;

  @IsBoolean()
  public is_voided!: boolean;

  @IsBoolean()
  public is_standalone_payment!: boolean;

  @IsBoolean()
  public has_parent_transaction!: boolean;

  @IsNumber()
  public integration_id!: number;

  @IsNumber()
  public owner!: number;

  @IsString()
  public created_at!: string;

  @ApiProperty({ description: 'Source data' })
  @ValidateNested()
  @Type(() => PaymobSourceDataDto)
  public source_data!: PaymobSourceDataDto;

  @ApiProperty({ description: 'Order details' })
  @ValidateNested()
  @Type(() => PaymobOrderDto)
  public order!: PaymobOrderDto;

  @ApiProperty({ description: 'Data message (error details)', required: false })
  @IsOptional()
  @IsString()
  public data_message?: string;
}

export class PaymobWebhookDto {
  @ApiProperty({ description: 'Transaction object' })
  @ValidateNested()
  @Type(() => PaymobTransactionDto)
  public obj!: PaymobTransactionDto;

  @IsNotEmpty()
  public hmac!: string;

  @IsString()
  public type!: string;
}
