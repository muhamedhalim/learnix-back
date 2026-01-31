import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

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
  @Matches(/^01[0-2,5]{1}[0-9]{8}$/, {
    message:
      'Phone must be a valid Egyptian phone number (11 digits starting with 01)',
  })
  public phone!: string;

  @IsNotEmpty()
  public email!: string;

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
  public parentPhone?: string;
}
