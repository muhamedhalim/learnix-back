import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  MaxLength,
  MinLength,
  IsOptional,
  IsEnum,
} from 'class-validator';
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
  name?: string;

  @ApiProperty({
    description: 'Subject description',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    description: 'Grade level',
    example: 'grade_12',
    enum: GradeLevel,
    required: false,
  })
  @IsEnum(GradeLevel)
  @IsOptional()
  gradeLevel?: GradeLevel;

  @ApiProperty({
    description: 'Thumbnail image URL',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  thumbnail?: string;
}
