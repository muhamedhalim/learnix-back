import { ApiProperty } from '@nestjs/swagger';

import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { GradeLevel } from './create-subject.dto';

export class UpdateSubjectDto {
  @ApiProperty({
    description: 'Subject name',
    example: 'الفيزياء المتقدمة',
    required: false,
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(255)
  public name?: string;

  @ApiProperty({
    description: 'Subject name (Arabic)',
    required: false,
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  public name_ar?: string;

  @ApiProperty({
    description: 'Subject description',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  public description?: string;

  @ApiProperty({
    description: 'Subject description (Arabic)',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  public description_ar?: string;

  @ApiProperty({
    description: 'Grade level',
    example: 'grade_12',
    enum: GradeLevel,
    required: false,
  })
  @IsEnum(GradeLevel)
  @IsOptional()
  public gradeLevel?: GradeLevel;

  @ApiProperty({
    description: 'Thumbnail image URL',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  public thumbnail?: string;
}
