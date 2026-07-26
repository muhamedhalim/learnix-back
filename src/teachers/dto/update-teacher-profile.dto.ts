import { ApiProperty } from '@nestjs/swagger';

import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { bi } from '../../i18n/error-translator.util';

export class EducationEntryDto {
  @ApiProperty({ description: 'Institution name', example: 'Cairo University' })
  @IsString()
  @MaxLength(200)
  public institution!: string;

  @ApiProperty({ description: 'Degree earned', example: 'B.Sc in Physics' })
  @IsString()
  @MaxLength(200)
  public degree!: string;

  @ApiProperty({ description: 'Year completed', example: '2015', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  public year?: string;
}

export class CertificateEntryDto {
  @ApiProperty({ description: 'Certificate name', example: 'Certified Physics Educator' })
  @IsString()
  @MaxLength(200)
  public name!: string;

  @ApiProperty({ description: 'Issuing organization', example: 'Ministry of Education', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  public issuer?: string;

  @ApiProperty({ description: 'Year issued', example: '2020', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  public year?: string;
}

export class UpdateTeacherProfileDto {
  @ApiProperty({
    description: 'Teacher qualifications/credentials',
    example: 'B.Sc in Physics, M.Ed in Education',
    required: false,
    maxLength: 2000,
  })
  @IsOptional()
  @Transform(({ value }): unknown => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(2000)
  public qualifications?: string;

  @ApiProperty({
    description: 'Years of teaching experience',
    example: 5,
    required: false,
    minimum: 0,
  })
  @IsInt()
  @IsOptional()
  @Min(0)
  public years_of_experience?: number;

  @ApiProperty({
    description: 'Teacher biography',
    example: 'Experienced physics teacher specializing in mechanics and thermodynamics',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  public bio?: string;

  @ApiProperty({
    description: 'Teacher biography (Arabic)',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  public bio_ar?: string;

  @ApiProperty({
    description: 'Professional headline/title',
    example: 'Senior Physics Instructor',
    required: false,
    maxLength: 150,
  })
  @IsString()
  @IsOptional()
  @MaxLength(150)
  public professional_title?: string;

  @ApiProperty({
    description: 'Professional headline/title (Arabic)',
    required: false,
    maxLength: 150,
  })
  @IsString()
  @IsOptional()
  @MaxLength(150)
  public professional_title_ar?: string;

  @ApiProperty({
    description: 'Areas of specialization',
    example: ['Mechanics', 'Thermodynamics'],
    required: false,
    type: [String],
  })
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  public specializations?: string[];

  @ApiProperty({
    description: 'Languages spoken',
    example: ['Arabic', 'English'],
    required: false,
    type: [String],
  })
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  public languages?: string[];

  @ApiProperty({
    description: 'Professional skills',
    example: ['Curriculum Design', 'Exam Writing'],
    required: false,
    type: [String],
  })
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  public skills?: string[];

  @ApiProperty({
    description: 'Education history',
    required: false,
    type: [EducationEntryDto],
  })
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EducationEntryDto)
  public education?: EducationEntryDto[];

  @ApiProperty({
    description: 'Certificates earned',
    required: false,
    type: [CertificateEntryDto],
  })
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CertificateEntryDto)
  public certificates?: CertificateEntryDto[];

  @ApiProperty({
    description: 'Phone number',
    example: '01012345678',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Matches(/^01[0125]\d{8}$/, {
    message: bi(
      'Phone must be a valid Egyptian mobile number (e.g., 01012345678)',
      'يجب أن يكون رقم الهاتف رقم موبايل مصري صالح (مثال: 01012345678)',
    ),
  })
  public phone?: string;
}
