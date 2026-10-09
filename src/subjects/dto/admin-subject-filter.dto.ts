import { ApiProperty } from '@nestjs/swagger';

import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';

import { SubjectStatus } from '../entities/subject-status.enum';
import { SubjectFilterDto } from './subject-filter.dto';

/** Filter for the admin subject catalogue: every status, optionally by owner. */
export class AdminSubjectFilterDto extends SubjectFilterDto {
  @ApiProperty({
    description: 'Filter by lifecycle status',
    required: false,
    enum: SubjectStatus,
  })
  @IsEnum(SubjectStatus)
  @IsOptional()
  public status?: SubjectStatus;

  @ApiProperty({
    description: "Filter by owning teacher's user ID",
    required: false,
    format: 'uuid',
  })
  @IsUUID()
  @IsOptional()
  public ownerId?: string;

  @ApiProperty({
    description: 'Add meta.status_counts (global per-status totals of live subjects)',
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }): boolean | undefined => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value as boolean | undefined;
  })
  public include_status_counts?: boolean;
}
