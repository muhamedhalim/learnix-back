import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';

import { ReviewStatus } from '../entities/review-status.enum';
import { ReviewTargetType } from '../entities/review-helpful-vote.entity';

/** Admin sets a review's moderation status. */
export class ModerateReviewDto {
  @IsEnum(ReviewStatus)
  public status!: ReviewStatus;
}

/** Admin moderation listing filter. */
export class ModerationFilterDto {
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

  /** Restrict to one review table; omit for both. */
  @IsOptional()
  @IsEnum(ReviewTargetType)
  public type?: ReviewTargetType;

  /** Restrict to a moderation status; omit for all. */
  @IsOptional()
  @IsEnum(ReviewStatus)
  public status?: ReviewStatus;
}
