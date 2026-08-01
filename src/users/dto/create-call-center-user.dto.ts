import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { bi } from '../../i18n/error-translator.util';

/**
 * Admin-only provisioning input. There is intentionally no `role` field: this
 * endpoint always creates a CALL_CENTER user and callers cannot mass-assign a
 * different role through it.
 */
export class CreateCallCenterUserDto {
  @ApiProperty({ example: 'support_agent_1' })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_]+$/)
  public username!: string;

  @ApiProperty({ example: 'Support Agent' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  public name!: string;

  @ApiProperty({ example: 'support@example.com' })
  @IsEmail()
  @IsNotEmpty()
  public email!: string;

  @ApiProperty({ example: '01000000000' })
  @IsString()
  @Matches(/^01[0125]\d{8}$/, {
    message: bi(
      'Phone must be a valid Egyptian phone number',
      'يجب أن يكون رقم الهاتف رقمًا مصريًا صالحًا',
    ),
  })
  public phone!: string;

  @ApiProperty({ example: 'S3curePass' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public password!: string;
}
