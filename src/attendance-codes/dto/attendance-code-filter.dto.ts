import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsBoolean, IsEnum, IsNumber } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { AttendanceCodeType } from '../entities/attendance-code-type.enum';

export class AttendanceCodeFilterDto extends PaginationDto {
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
    enum: AttendanceCodeType,
    required: false,
  })
  @IsOptional()
  @IsEnum(AttendanceCodeType)
  type?: AttendanceCodeType;

  @ApiProperty({
    description: 'Filter by item ID',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  item_id?: string;

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
