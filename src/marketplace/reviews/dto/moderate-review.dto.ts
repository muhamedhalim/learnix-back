import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** FR-261. `reason` is validated as mandatory in the service for `hide`/`remove`, not here — DTO-level validation can't express "required unless approve" cleanly. */
export enum ReviewModerationAction {
  APPROVE = 'approve',
  HIDE = 'hide',
  REMOVE = 'remove',
}

export class ModerateReviewDto {
  @IsEnum(ReviewModerationAction)
  public action!: ReviewModerationAction;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public reason?: string;
}
