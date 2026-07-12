import { ApiProperty } from '@nestjs/swagger';

import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { bi } from '../../i18n/error-translator.util';

export class RegisterDto {
  @MaxLength(100)
  public name!: string;

  @ApiProperty({ example: '123456', description: 'Password (min 6 chars)' })
  @MaxLength(128)
  public password!: string;

  @ApiProperty({
    example: '01000000000',
    description: 'Egyptian phone number (11 digits starting with 01)',
  })
  @IsString()
  @IsNotEmpty()
  // `[0125]`, not `[0-2,5]` — the latter is a character class containing a
  // literal comma, so it accepted `01,12345678`.
  @Matches(/^01[0125]\d{8}$/, {
    message: bi(
      'Phone must be a valid Egyptian phone number (11 digits starting with 01)',
      'يجب أن يكون رقم الهاتف رقمًا مصريًا صالحًا (11 رقمًا يبدأ بـ 01)',
    ),
  })
  public phone!: string;

  @IsNotEmpty()
  public email!: string;

  @ApiProperty({
    example: '01011111111',
    description:
      "Guardian's phone number (optional). Accepts Egyptian national or E.164 form; stored canonically as E.164 on a Guardian record, which must be verified by OTP before it receives any educational notification.",
    required: false,
  })
  @IsString()
  @IsOptional()
  // No @Matches: the previous pattern /^01[0-2,5]\d{8}$/ contained a character
  // class with a literal comma and accepted `01,12345678`. `toE164` is now the
  // single definition of a valid number and rejects it with a 400.
  public parentPhone?: string;
}
