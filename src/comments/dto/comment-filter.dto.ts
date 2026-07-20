import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';

export class CommentFilterDto {
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  public page = 1;

  @IsOptional()
  @StrictIntegerQuery({ max: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  public limit = 20;
}
