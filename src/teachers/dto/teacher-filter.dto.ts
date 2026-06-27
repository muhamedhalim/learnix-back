import { ApiProperty } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { UserStatus } from '../../users/entities/user-status.enum';

export class TeacherFilterDto {
  @ApiProperty({
    description: 'Search by name or email',
    required: false,
    example: 'Ali',
  })
  @IsString()
  @IsOptional()
  public search?: string;

  @ApiProperty({
    description: 'Filter by approval status',
    required: false,
    enum: UserStatus,
    example: UserStatus.PENDING,
  })
  @IsEnum(UserStatus)
  @IsOptional()
  public status?: UserStatus;

  @ApiProperty({
    description: 'Filter by subject ID',
    required: false,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsOptional()
  public subjectId?: string;

  @ApiProperty({
    description: 'Sort by field',
    required: false,
    enum: ['rating', 'name', 'created_at'],
    example: 'rating',
  })
  @IsString()
  @IsOptional()
  public sortBy?: 'rating' | 'name' | 'created_at';

  @ApiProperty({
    description: 'Sort order',
    required: false,
    enum: ['asc', 'desc'],
    example: 'desc',
  })
  @IsString()
  @IsOptional()
  public order?: 'asc' | 'desc';

  @ApiProperty({
    description: 'Page number',
    required: false,
    default: 1,
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  public page?: number = 1;

  @ApiProperty({
    description: 'Items per page',
    required: false,
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  public limit?: number = 20;
}
