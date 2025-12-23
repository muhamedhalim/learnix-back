import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  MaxLength,
  MinLength,
  IsInt,
  Min,
  Matches,
} from 'class-validator';

export class UpdateTeacherProfileDto {
  @ApiProperty({
    description: 'Teacher qualifications/credentials',
    example: 'B.Sc in Physics, M.Ed in Education',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MinLength(10)
  @MaxLength(2000)
  qualifications?: string;

  @ApiProperty({
    description: 'Years of teaching experience',
    example: 5,
    required: false,
    minimum: 0,
  })
  @IsInt()
  @IsOptional()
  @Min(0)
  years_of_experience?: number;

  @ApiProperty({
    description: 'Teacher biography',
    example:
      'Experienced physics teacher specializing in mechanics and thermodynamics',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  bio?: string;

  @ApiProperty({
    description: 'Phone number',
    example: '01012345678',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Matches(/^01[0125][0-9]{8}$/, {
    message: 'Phone must be a valid Egyptian mobile number (e.g., 01012345678)',
  })
  phone?: string;
}
