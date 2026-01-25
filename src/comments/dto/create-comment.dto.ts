import { MaxLength } from 'class-validator';

export class CreateCommentDto {
  @MaxLength(5000)
  public comment_text!: string;
}
