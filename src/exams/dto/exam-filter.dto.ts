import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsUUID,
  Min,
  Max,
  IsOptional,
  IsString,
  IsBoolean,
  IsEnum,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export enum ExamSortField {
  CREATED_AT = 'created_at',
  TITLE = 'title',
  TOTAL_MARKS = 'total_marks',
  DURATION = 'duration',
}

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

/**
 * DTO for filtering and paginating exam lists
 */
export class ExamFilterDto {
  @ApiProperty({
    description: 'Page number (1-based)',
    example: 1,
    required: false,
    default: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiProperty({
    description: 'Items per page (max 100)',
    example: 20,
    required: false,
    default: 20,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 20;

  @ApiProperty({
    description: 'Search term for title (English or Arabic)',
    example: 'Math',
    required: false,
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiProperty({
    description: 'Filter by subject ID (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    required: false,
  })
  @IsUUID('4')
  @IsOptional()
  subject_id?: string;

  @ApiProperty({
    description: 'Filter by active status',
    example: true,
    required: false,
  })
  @Transform(({ value }): boolean | undefined => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  })
  @IsBoolean()
  @IsOptional()
  is_active?: boolean;

  @ApiProperty({
    description: 'Sort field',
    enum: ExamSortField,
    example: ExamSortField.CREATED_AT,
    required: false,
    default: ExamSortField.CREATED_AT,
  })
  @IsEnum(ExamSortField)
  @IsOptional()
  sort_by?: ExamSortField = ExamSortField.CREATED_AT;

  @ApiProperty({
    description: 'Sort order',
    enum: SortOrder,
    example: SortOrder.DESC,
    required: false,
    default: SortOrder.DESC,
  })
  @IsEnum(SortOrder)
  @IsOptional()
  sort_order?: SortOrder = SortOrder.DESC;
}

/**
 * DTO for student-specific exam filtering
 */
export class StudentExamFilterDto extends ExamFilterDto {
  @ApiProperty({
    description: 'Filter to show only attempted or not attempted exams',
    example: false,
    required: false,
  })
  @Transform(({ value }): boolean | undefined => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  })
  @IsBoolean()
  @IsOptional()
  attempted?: boolean;
}
