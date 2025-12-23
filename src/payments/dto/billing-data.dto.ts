import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  MaxLength,
  Matches,
} from 'class-validator';

export class BillingDataDto {
  @ApiProperty({
    description: 'Customer first name',
    example: 'Ahmed',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  first_name!: string;

  @ApiProperty({
    description: 'Customer last name',
    example: 'Mohamed',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  last_name!: string;

  @ApiProperty({
    description: 'Customer email',
    example: 'ahmed@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({
    description: 'Customer phone number (Egyptian format)',
    example: '01012345678',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^01[0-2,5][0-9]{8}$/, {
    message: 'Phone must be a valid Egyptian mobile number (e.g., 01012345678)',
  })
  phone_number!: string;

  @ApiPropertyOptional({
    description: 'Building number or name',
    example: '15',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  building?: string;

  @ApiPropertyOptional({
    description: 'Street name',
    example: 'Ahmed Orabi Street',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  street?: string;

  @ApiPropertyOptional({
    description: 'Floor number',
    example: '3',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  floor?: string;

  @ApiPropertyOptional({
    description: 'Apartment number',
    example: '12',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  apartment?: string;

  @ApiProperty({
    description: 'City',
    example: 'Cairo',
    default: 'Cairo',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;

  @ApiProperty({
    description: 'State or governorate',
    example: 'Cairo',
    default: 'Cairo',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state!: string;

  @ApiProperty({
    description: 'Country (ISO code)',
    example: 'EG',
    default: 'EG',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(3)
  country!: string;

  @ApiPropertyOptional({
    description: 'Postal code',
    example: '11511',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  postal_code?: string;
}
