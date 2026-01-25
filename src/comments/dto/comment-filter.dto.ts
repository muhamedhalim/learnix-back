import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class CommentFilterDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public limit = 20;
}
