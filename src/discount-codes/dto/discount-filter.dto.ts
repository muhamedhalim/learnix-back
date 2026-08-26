import { ApiProperty } from '@nestjs/swagger';

import { IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationDto } from '../../common/dto/pagination.dto';
import { DiscountType } from '../entities/discount-type.enum';
import { StrictBooleanQuery } from '../../common/decorators/strict-boolean-query.decorator';

export class DiscountFilterDto extends PaginationDto {
  @ApiProperty({
    description: 'Search by discount code value',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  public search?: string;

  @ApiProperty({
    description: 'Filter by active status',
    required: false,
  })
  @StrictBooleanQuery()
  public is_active?: boolean;

  @ApiProperty({
    description: 'Filter by discount type',
    enum: DiscountType,
    required: false,
  })
  @IsOptional()
  @IsEnum(DiscountType)
  public discount_type?: DiscountType;

  @ApiProperty({
    description: 'Filter codes valid from this date',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  public valid_from?: string;

  @ApiProperty({
    description: 'Filter codes valid until this date',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  public valid_until?: string;

  @ApiProperty({
    description: 'Include expired codes',
    required: false,
    default: false,
  })
  @StrictBooleanQuery()
  public include_expired?: boolean;
}
