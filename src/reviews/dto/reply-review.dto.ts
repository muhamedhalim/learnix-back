import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** A teacher's public reply to a review on one of their lessons. */
export class ReplyReviewDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  public reply!: string;
}
