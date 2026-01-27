import { IsOptional, IsString, Max, MaxLength } from 'class-validator';

export class CreateReviewDto {
  @Max(5)
  public rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  public comment?: string;
}
