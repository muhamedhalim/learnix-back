import { IsString, IsNotEmpty, MinLength, MaxLength } from 'class-validator';

export class CreateReplyDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(5000)
  reply_text!: string;
}
