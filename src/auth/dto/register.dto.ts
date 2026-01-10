import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'Ahmed Ali', description: 'Full name of the user' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: '123456', description: 'Password (min 6 chars)' })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  @MaxLength(128)
  password!: string;

  @ApiProperty({
    example: '01000000000',
    description: 'Egyptian phone number (11 digits starting with 01)',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^01[0-2,5]{1}[0-9]{8}$/, {
    message:
      'Phone must be a valid Egyptian phone number (11 digits starting with 01)',
  })
  phone!: string;

  @ApiProperty({ example: 'test@test.com', description: 'Email address' })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({
    example: '01011111111',
    description: 'Parent phone number (optional, 11 digits starting with 01)',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Matches(/^01[0-2,5]{1}[0-9]{8}$/, {
    message:
      'Parent phone must be a valid Egyptian phone number (11 digits starting with 01)',
  })
  parentPhone?: string;
}
