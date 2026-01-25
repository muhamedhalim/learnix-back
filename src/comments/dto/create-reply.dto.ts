import { MaxLength } from 'class-validator';

export class CreateReplyDto {
  @MaxLength(5000)
  public reply_text!: string;
}
