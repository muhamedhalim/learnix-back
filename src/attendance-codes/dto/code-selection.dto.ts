import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

import { AttendanceCodeStatus } from '../entities/attendance-code-status.enum';
import { AttendanceCodeType } from '../entities/attendance-code-type.enum';

/**
 * The set of filters that select attendance codes for listing, exporting or
 * bulk targeting. Shared (via composition) by the codes table query and the
 * export request so the selection semantics stay identical everywhere.
 */
export class CodeSelectionDto {
  @ApiPropertyOptional({ description: 'Search by code value' })
  @IsOptional()
  @IsString()
  public search?: string;

  @ApiPropertyOptional({ description: 'Filter by batch ID' })
  @IsOptional()
  @IsUUID('4')
  public batch_id?: string;

  @ApiPropertyOptional({
    enum: AttendanceCodeStatus,
    description: 'Lifecycle status',
  })
  @IsOptional()
  @IsEnum(AttendanceCodeStatus)
  public status?: AttendanceCodeStatus;

  @ApiPropertyOptional({
    enum: AttendanceCodeType,
    description: 'Item type (lesson/package/book)',
  })
  @IsOptional()
  @IsEnum(AttendanceCodeType)
  public type?: AttendanceCodeType;

  @ApiPropertyOptional({ description: 'Item ID (lesson/course/book)' })
  @IsOptional()
  @IsUUID('4')
  public item_id?: string;

  @ApiPropertyOptional({ description: 'Creator (teacher/admin) user ID' })
  @IsOptional()
  @IsUUID('4')
  public created_by?: string;

  @ApiPropertyOptional({ description: 'Redeemer (student) user ID' })
  @IsOptional()
  @IsUUID('4')
  public used_by?: string;

  @ApiPropertyOptional({ description: 'Created on/after this date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  public from_date?: string;

  @ApiPropertyOptional({ description: 'Created on/before this date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  public to_date?: string;
}
