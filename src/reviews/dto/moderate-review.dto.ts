import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';
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

  /** Restrict to one review table; omit for both. */
  @IsOptional()
  @IsEnum(ReviewTargetType)
  public type?: ReviewTargetType;

  /** Restrict to a moderation status; omit for all. */
  @IsOptional()
  @IsEnum(ReviewStatus)
  public status?: ReviewStatus;
}
