import { ApiProperty } from '@nestjs/swagger';

import { IsEmail, IsNotEmpty } from 'class-validator';

import { bi } from '../../i18n/error-translator.util';

export class ForgotPasswordDto {
  @ApiProperty({
    example: 'student@example.com',
    description: 'Email address of the account to recover',
  })
  @IsNotEmpty()
  @IsEmail(
    {},
    { message: bi('A valid email address is required', 'يرجى إدخال بريد إلكتروني صالح') },
  )
  public email!: string;
}
