import { ApiProperty } from '@nestjs/swagger';

import {
  IsEmail,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { bi } from '../../i18n/error-translator.util';

export class UpdateUserDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  public name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail()
  public email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  // `[0125]`, not `[0-2,5]` — the latter admitted a literal comma.
  @Matches(/^01[0125]\d{8}$/, {
    message: bi(
      'Phone must be a valid Egyptian phone number',
      'يجب أن يكون رقم الهاتف رقمًا مصريًا صالحًا',
    ),
  })
  public phone?: string;

  // `parentPhone` removed: guardians are managed through the guardian domain,
  // never as a free-text column on the user an admin can overwrite.

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  public profile_picture_url?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public headline?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public bio?: string;
}
