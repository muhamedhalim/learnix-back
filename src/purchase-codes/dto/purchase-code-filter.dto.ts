import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsBoolean, IsEnum, IsNumber } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { PurchaseCodeType } from '../entities/purchase-code-type.enum';

export class PurchaseCodeFilterDto extends PaginationDto {
  @ApiProperty({
    description: 'Filter by used status',
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  is_used?: boolean;

  @ApiProperty({
    description: 'Filter by type',
    enum: PurchaseCodeType,
    required: false,
  })
  @IsOptional()
  @IsEnum(PurchaseCodeType)
  type?: PurchaseCodeType;

  @ApiProperty({
    description: 'Filter by item ID',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  item_id?: number;

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
