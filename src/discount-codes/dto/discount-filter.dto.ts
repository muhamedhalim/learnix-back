import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsBoolean, IsEnum, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { DiscountType } from '../entities/discount-type.enum';

export class DiscountFilterDto extends PaginationDto {
  @ApiProperty({
    description: 'Filter by active status',
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  is_active?: boolean;

  @ApiProperty({
    description: 'Filter by discount type',
    enum: DiscountType,
    required: false,
  })
  @IsOptional()
  @IsEnum(DiscountType)
  discount_type?: DiscountType;

  @ApiProperty({
    description: 'Filter codes valid from this date',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  valid_from?: string;

  @ApiProperty({
    description: 'Filter codes valid until this date',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  valid_until?: string;

  @ApiProperty({
    description: 'Include expired codes',
    required: false,
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  include_expired?: boolean;
}
