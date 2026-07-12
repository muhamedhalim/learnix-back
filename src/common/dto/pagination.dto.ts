import { ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { bi } from '../../i18n/error-translator.util';

export class PaginationDto {
  @ApiPropertyOptional({
    description: 'Page number (1-based)',
    minimum: 1,
    default: 1,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: bi('Page must be an integer', 'يجب أن تكون الصفحة رقمًا صحيحًا') })
  @Min(1, { message: bi('Page must be at least 1', 'يجب ألا تقل الصفحة عن 1') })
  public page = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    minimum: 1,
    maximum: 100,
    default: 10,
    example: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: bi('Limit must be an integer', 'يجب أن يكون الحد رقمًا صحيحًا') })
  @Min(1, { message: bi('Limit must be at least 1', 'يجب ألا يقل الحد عن 1') })
  @Max(100, {
    message: bi('Limit cannot exceed 100 items per page', 'يجب ألا يتجاوز الحد 100 عنصر لكل صفحة'),
  })
  public limit = 10;
}
