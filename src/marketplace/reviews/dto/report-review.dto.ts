import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ReportReviewDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  public reason!: string;
}
