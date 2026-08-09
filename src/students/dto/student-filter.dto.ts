import { ApiProperty, OmitType } from '@nestjs/swagger';

import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';
import { UserStatus } from '../../users/entities/user-status.enum';

export class StudentFilterDto {
  @ApiProperty({
    description: 'Search by name or email',
    required: false,
    example: 'Ahmed',
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
    description: 'Sort by field',
    required: false,
    enum: ['name', 'created_at'],
    example: 'created_at',
  })
  @IsString()
  @IsOptional()
  public sortBy?: 'name' | 'created_at';

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
  @StrictIntegerQuery()
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
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  public limit?: number = 20;
}

/** Public directory filters cannot override the enforced APPROVED status. */
export class PublicStudentFilterDto extends OmitType(StudentFilterDto, [
  'status',
] as const) {}
