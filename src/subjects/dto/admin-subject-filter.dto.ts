import { ApiProperty } from '@nestjs/swagger';

import { IsEnum, IsOptional, IsUUID } from 'class-validator';

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
}
