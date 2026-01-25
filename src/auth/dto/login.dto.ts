import { IsNotEmpty } from 'class-validator';

export class LoginDto {
  @IsNotEmpty()
  public email!: string;

  @IsNotEmpty()
  public password!: string;
}
