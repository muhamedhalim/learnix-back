import { ApiProperty } from '@nestjs/swagger';

import { PaginationDto } from '../../common/dto/pagination.dto';
import { AttendanceCodeType } from '../entities/attendance-code-type.enum';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsNumber,IsOptional } from 'class-validator';

export class AttendanceCodeFilterDto extends PaginationDto {
  @ApiProperty({
    description: 'Filter by used status',
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
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
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  public include_expired?: boolean;
}
