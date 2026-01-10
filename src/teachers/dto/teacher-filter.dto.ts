import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsEnum,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserStatus } from '../../users/entities/user-status.enum';

export class TeacherFilterDto {
  @ApiProperty({
    description: 'Search by name or email',
    required: false,
    example: 'Ali',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiProperty({
    description: 'Filter by approval status',
    required: false,
    enum: UserStatus,
    example: UserStatus.PENDING,
  })
  @IsEnum(UserStatus)
  @IsOptional()
  status?: UserStatus;

  @ApiProperty({
    description: 'Filter by subject ID',
    required: false,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsOptional()
  subjectId?: string;

  @ApiProperty({
    description: 'Sort by field',
    required: false,
    enum: ['rating', 'name', 'created_at'],
    example: 'rating',
  })
  @IsString()
  @IsOptional()
  sortBy?: 'rating' | 'name' | 'created_at';

  @ApiProperty({
    description: 'Sort order',
    required: false,
    enum: ['asc', 'desc'],
    example: 'desc',
  })
  @IsString()
  @IsOptional()
  order?: 'asc' | 'desc';

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
  page?: number = 1;

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
  limit?: number = 20;
}
