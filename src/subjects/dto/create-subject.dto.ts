import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  MaxLength,
  MinLength,
  IsOptional,
} from 'class-validator';

export class CreateSubjectDto {
  @ApiProperty({
    description: 'Subject name in English',
    example: 'Physics',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(255)
  title!: string;

  @ApiProperty({
    description: 'Subject name in Arabic',
    example: 'الفيزياء',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(255)
  title_ar!: string;

  @ApiProperty({
    description: 'Subject description in English',
    example:
      'Physics for high school students covering mechanics and thermodynamics',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    description: 'Subject description in Arabic',
    example: 'الفيزياء للمرحلة الثانوية تشمل الميكانيكا والديناميكا الحرارية',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description_ar?: string;
}
