import { ApiProperty } from '@nestjs/swagger';

import { IsEmail, IsNotEmpty } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({
    example: 'student@example.com',
    description: 'Email address of the account to recover',
  })
  @IsNotEmpty()
  @IsEmail({}, { message: 'A valid email address is required' })
  public email!: string;
}
