import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsEnum, IsOptional, IsString } from 'class-validator';

/**
 * Payment method types for cart checkout
 */
export enum PaymentMethod {
  PAYMOB = 'paymob',
  ATTENDANCE_CODE = 'attendance_code',
}

/**
 * DTO for checking out cart
 */
export class CheckoutCartDto {
  @IsEnum(PaymentMethod)
  public paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({
    description: 'Discount code to apply (optional)',
    example: 'SUMMER2024',
  })
  @IsOptional()
  @IsString()
  public discountCode?: string;

  @ApiPropertyOptional({
    description:
      'Attendance code (required if paymentMethod is attendance_code)',
    example: 'ABC123',
  })
  @IsOptional()
  @IsString()
  public attendanceCode?: string;
}
