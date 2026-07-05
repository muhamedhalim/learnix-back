import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class BillingDataDto {
  @MaxLength(100)
  public first_name!: string;

  @MaxLength(100)
  public last_name!: string;

  @IsNotEmpty()
  public email!: string;

  @ApiProperty({
    description: 'Customer phone number (Egyptian format)',
    example: '01012345678',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^01[0-2,5]\d{8}$/, {
    message: 'Phone must be a valid Egyptian mobile number (e.g., 01012345678)',
  })
  public phone_number!: string;

  @ApiPropertyOptional({
    description: 'Building number or name',
    example: '15',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  public building?: string;

  @ApiPropertyOptional({
    description: 'Street name',
    example: 'Ahmed Orabi Street',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public street?: string;

  @ApiPropertyOptional({
    description: 'Floor number',
    example: '3',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  public floor?: string;

  @ApiPropertyOptional({
    description: 'Apartment number',
    example: '12',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  public apartment?: string;

  @MaxLength(100)
  public city!: string;

  @MaxLength(100)
  public state!: string;

  @ApiProperty({
    description: 'Country (ISO code)',
    example: 'EG',
    default: 'EG',
  })
  @MaxLength(3)
  public country!: string;

  @ApiPropertyOptional({
    description: 'Postal code',
    example: '11511',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  public postal_code?: string;
}
