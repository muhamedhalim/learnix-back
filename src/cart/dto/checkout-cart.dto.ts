import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
  @ApiProperty({
    description: 'Payment method',
    enum: PaymentMethod,
    example: PaymentMethod.PAYMOB,
  })
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({
    description: 'Discount code to apply (optional)',
    example: 'SUMMER2024',
  })
  @IsOptional()
  @IsString()
  discountCode?: string;

  @ApiPropertyOptional({
    description:
      'Attendance code (required if paymentMethod is attendance_code)',
    example: 'ABC123',
  })
  @IsOptional()
  @IsString()
  attendanceCode?: string;
}
