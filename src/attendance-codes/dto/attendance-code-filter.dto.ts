import { ApiProperty } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationDto } from '../../common/dto/pagination.dto';
import { AttendanceCodeType } from '../entities/attendance-code-type.enum';
import { StrictBooleanQuery } from '../../common/decorators/strict-boolean-query.decorator';

export class AttendanceCodeFilterDto extends PaginationDto {
  @ApiProperty({
    description: 'Search by attendance code value',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  public search?: string;

  @ApiProperty({
    description: 'Filter by used status',
    required: false,
  })
  @StrictBooleanQuery()
  public is_used?: boolean;

  @ApiProperty({
    description: 'Filter by type',
    enum: AttendanceCodeType,
    required: false,
  })
  @IsOptional()
  @IsEnum(AttendanceCodeType)
  public type?: AttendanceCodeType;

  @ApiProperty({
    description: 'Filter by item ID',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  public item_id?: string;

  @ApiProperty({
    description: 'Include expired codes',
    required: false,
    default: false,
  })
  @StrictBooleanQuery()
  public include_expired?: boolean;
}
