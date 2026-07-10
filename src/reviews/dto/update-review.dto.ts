import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Partial update of a student's own review. At least one field is expected;
 * both are optional so a caller can change just the rating or just the comment.
 */
export class UpdateReviewDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  public rating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  public comment?: string;
}
