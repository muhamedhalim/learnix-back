import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { bi } from '../../i18n/error-translator.util';
import { StrictIntegerQuery } from '../decorators/strict-integer-query.decorator';

export class PaginationDto {
  @ApiPropertyOptional({
    description: 'Page number (1-based)',
    minimum: 1,
    default: 1,
    example: 1,
  })
  @IsOptional()
  @StrictIntegerQuery()
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
  @StrictIntegerQuery()
  @IsInt({ message: bi('Limit must be an integer', 'يجب أن يكون الحد رقمًا صحيحًا') })
  @Min(1, { message: bi('Limit must be at least 1', 'يجب ألا يقل الحد عن 1') })
  @Max(100, {
    message: bi('Limit cannot exceed 100 items per page', 'يجب ألا يتجاوز الحد 100 عنصر لكل صفحة'),
  })
  public limit = 10;
}

/** Standard page size for user-facing collection endpoints. */
export class Pagination20Dto extends PaginationDto {
  public override page = 1;
  public override limit = 20;
}

/** Strictly validated limit-only query used by small analytics lists. */
export class LimitQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 10 })
  @IsOptional()
  @StrictIntegerQuery({ max: 100 })
  public limit = 10;
}
