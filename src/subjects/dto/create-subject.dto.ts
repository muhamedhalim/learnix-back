import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  MaxLength,
  MinLength,
  IsOptional,
  IsEnum,
} from 'class-validator';

export enum GradeLevel {
  GRADE_10 = 'grade_10',
  GRADE_11 = 'grade_11',
  GRADE_12 = 'grade_12',
}

export class CreateSubjectDto {
  @ApiProperty({
    description: 'Subject name',
    example: 'الفيزياء',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @ApiProperty({
    description: 'Subject description',
    example: 'مادة الفيزياء للصف الثالث الثانوي',
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
    default: GradeLevel.GRADE_12,
  })
  @IsEnum(GradeLevel)
  @IsNotEmpty()
  gradeLevel!: GradeLevel;

  @ApiProperty({
    description: 'Thumbnail image URL',
    example: '/uploads/thumbnails/physics.jpg',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  thumbnail?: string;
}
