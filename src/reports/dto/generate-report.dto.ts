import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsDateString,
  IsArray,
  IsInt,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FileFormat } from '../entities';

export class BaseReportDto {
  @ApiPropertyOptional({
    description: 'Start date for report period (ISO 8601)',
    example: '2025-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'End date for report period (ISO 8601)',
    example: '2025-12-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({
    description: 'Output file format',
    enum: FileFormat,
    example: FileFormat.CSV,
  })
  @IsEnum(FileFormat)
  format!: FileFormat;
}

export class GenerateStudentReportDto extends BaseReportDto {
  @ApiPropertyOptional({
    description: 'Filter by specific student IDs',
    type: [Number],
    example: [1, 2, 3],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  studentIds?: number[];

  @ApiPropertyOptional({
    description: 'Filter by subject ID',
    type: Number,
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  subjectId?: number;
}

export class GenerateTeacherReportDto extends BaseReportDto {
  @ApiPropertyOptional({
    description: 'Filter by specific teacher IDs',
    type: [Number],
    example: [1, 2, 3],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  teacherIds?: number[];

  @ApiPropertyOptional({
    description: 'Filter by subject ID',
    type: Number,
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  subjectId?: number;
}

export class GenerateRevenueReportDto extends BaseReportDto {
  @ApiPropertyOptional({
    description: 'Filter by payment method',
    type: String,
    example: 'card',
  })
  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @ApiPropertyOptional({
    description: 'Filter by subject ID',
    type: Number,
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  subjectId?: number;
}

export class GenerateExamReportDto extends BaseReportDto {
  @ApiPropertyOptional({
    description: 'Filter by specific exam IDs',
    type: [Number],
    example: [1, 2, 3],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  examIds?: number[];

  @ApiPropertyOptional({
    description: 'Filter by teacher ID',
    type: Number,
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  teacherId?: number;
}

export class GenerateContentReportDto extends BaseReportDto {
  @ApiPropertyOptional({
    description: 'Filter by subject ID',
    type: Number,
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  subjectId?: number;
}
