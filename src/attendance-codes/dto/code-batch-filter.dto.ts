import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

import { PaginationDto } from '../../common/dto/pagination.dto';
import { AttendanceCodeType } from '../entities/attendance-code-type.enum';
import { CodeBatchStatus } from '../entities/code-batch-status.enum';

export class CodeBatchFilterDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search by batch name' })
  @IsOptional()
  @IsString()
  public search?: string;

  @ApiPropertyOptional({ enum: CodeBatchStatus, description: 'Filter by generation status' })
  @IsOptional()
  @IsEnum(CodeBatchStatus)
  public status?: CodeBatchStatus;

  @ApiPropertyOptional({ enum: AttendanceCodeType, description: 'Filter by item type' })
  @IsOptional()
  @IsEnum(AttendanceCodeType)
  public type?: AttendanceCodeType;

  @ApiPropertyOptional({ description: 'Filter by creator user ID' })
  @IsOptional()
  @IsUUID('4')
  public created_by?: string;

  @ApiPropertyOptional({ description: 'Created on/after this date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  public from_date?: string;

  @ApiPropertyOptional({ description: 'Created on/before this date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  public to_date?: string;
}
