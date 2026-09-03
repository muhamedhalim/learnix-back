import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/** FR-254. Comment max length mirrors the academic reviews module's own limit (`src/reviews/dto/create-review.dto.ts`) — no separate number is specified anywhere in this feature's design docs, and reusing the established value keeps the two systems' UX consistent. */
export class CreateReviewDto {
  @IsUUID()
  public courseId!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  public rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  public comment?: string;
}
