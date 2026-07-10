import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  public rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  public comment?: string;
}
