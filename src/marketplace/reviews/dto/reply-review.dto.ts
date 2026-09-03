import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ReplyReviewDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  public reply!: string;
}
