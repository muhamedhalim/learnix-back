import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

/** FR-238, FR-239, FR-334 — a completion flag and a position only; a client-supplied percentage or timestamp has no field to arrive in at all. */
export class UpdateLessonProgressDto {
  @IsOptional()
  @IsBoolean()
  public is_completed?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  public position_seconds?: number;
}
