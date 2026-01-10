import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  MaxLength,
  IsInt,
  IsUUID,
  Min,
  IsNumber,
  IsBoolean,
} from 'class-validator';

export class UpdateLessonDto {
  @ApiProperty({
    description: 'Lesson title in English',
    example: 'Introduction to Algebra - Updated',
    required: false,
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  title?: string;

  @ApiProperty({
    description: 'Lesson title in Arabic',
    example: 'مقدمة في الجبر - محدث',
    required: false,
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  title_ar?: string;

  @ApiProperty({
    description: 'Lesson description in English',
    example: 'Updated: Learn the fundamentals of algebraic expressions.',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Lesson description in Arabic',
    example: 'محدث: تعلم أساسيات التعبيرات الجبرية.',
    required: false,
  })
  @IsString()
  @IsOptional()
  description_ar?: string;

  @ApiProperty({
    description: 'Subject ID this lesson belongs to (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    required: false,
  })
  @IsUUID('4', { message: 'Subject ID must be a valid UUID' })
  @IsOptional()
  subject_id?: string;

  @ApiProperty({
    description: 'Lesson price in EGP',
    example: 75.0,
    required: false,
    minimum: 0,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsOptional()
  @Min(0, { message: 'Price cannot be negative' })
  price?: number;

  @ApiProperty({
    description: 'Lesson thumbnail URL',
    example: 'https://example.com/thumbnails/lesson1-new.jpg',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  thumbnail?: string;

  @ApiProperty({
    description: 'Whether this is a group lesson',
    example: true,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  is_group?: boolean;

  @ApiProperty({
    description: 'Number of days the lesson is available after purchase',
    example: 14,
    required: false,
    minimum: 1,
  })
  @IsInt()
  @IsOptional()
  @Min(1, { message: 'Lesson must be available for at least 1 day' })
  available_for_days?: number;
}
