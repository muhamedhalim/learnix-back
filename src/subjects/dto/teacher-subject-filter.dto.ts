import { ApiProperty } from '@nestjs/swagger';

import { IsEnum, IsOptional } from 'class-validator';

import { SubjectStatus } from '../entities/subject-status.enum';
import { SubjectFilterDto } from './subject-filter.dto';

/** Filter for a teacher listing their own subjects (any status). */
export class TeacherSubjectFilterDto extends SubjectFilterDto {
  @ApiProperty({
    description: 'Filter by lifecycle status',
    required: false,
    enum: SubjectStatus,
  })
  @IsEnum(SubjectStatus)
  @IsOptional()
  public status?: SubjectStatus;
}
