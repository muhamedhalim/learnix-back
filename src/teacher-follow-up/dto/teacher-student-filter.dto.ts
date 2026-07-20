import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';

export class TeacherStudentFilterDto {
  @ApiPropertyOptional({ description: 'Search by student name, email, or phone' })
  @IsOptional()
  @IsString()
  public search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number;
}
