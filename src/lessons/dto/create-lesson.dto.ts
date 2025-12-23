import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsNotEmpty,
  MaxLength,
  IsInt,
  Min,
  IsNumber,
  IsBoolean,
} from 'class-validator';

export class CreateLessonDto {
  @ApiProperty({
    description: 'Lesson title in English',
    example: 'Introduction to Algebra',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  @MaxLength(255)
  title!: string;

  @ApiProperty({
    description: 'Lesson title in Arabic',
    example: 'مقدمة في الجبر',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty({ message: 'Arabic title is required' })
  @MaxLength(255)
  title_ar!: string;

  @ApiProperty({
    description: 'Lesson description in English',
    example: 'Learn the fundamentals of algebraic expressions and equations.',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Lesson description in Arabic',
    example: 'تعلم أساسيات التعبيرات والمعادلات الجبرية.',
    required: false,
  })
  @IsString()
  @IsOptional()
  description_ar?: string;

  @ApiProperty({
    description: 'Subject ID this lesson belongs to',
    example: 1,
  })
  @IsInt()
  @Min(1)
  subject_id!: number;

  @ApiProperty({
    description: 'Lesson price in EGP',
    example: 50.0,
    minimum: 0,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Price cannot be negative' })
  price!: number;

  @ApiProperty({
    description: 'Lesson thumbnail URL',
    example: 'https://example.com/thumbnails/lesson1.jpg',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  thumbnail?: string;

  @ApiProperty({
    description: 'Vimeo video ID (from Vimeo dashboard)',
    example: '123456789',
    required: false,
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  vimeo_video_id?: string;

  @ApiProperty({
    description: 'Video duration in seconds',
    example: 3600,
    required: false,
    minimum: 0,
  })
  @IsInt()
  @IsOptional()
  @Min(0)
  duration?: number;

  @ApiProperty({
    description: 'Whether this is a group lesson',
    example: false,
    required: false,
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  is_group?: boolean;

  @ApiProperty({
    description: 'Number of days the lesson is available after purchase',
    example: 7,
    required: false,
    default: 7,
    minimum: 1,
  })
  @IsInt()
  @IsOptional()
  @Min(1, { message: 'Lesson must be available for at least 1 day' })
  available_for_days?: number;
}
