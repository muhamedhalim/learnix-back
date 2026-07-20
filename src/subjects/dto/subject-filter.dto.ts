import { ApiProperty } from '@nestjs/swagger';

import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';

export class SubjectFilterDto {
  @ApiProperty({
    description: 'Search by subject name',
    required: false,
    example: 'الفيزياء',
  })
  @IsString()
  @IsOptional()
  public search?: string;

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
