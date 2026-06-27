import { ApiProperty } from '@nestjs/swagger';

import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateLessonDto {
  @MaxLength(255)
  public title!: string;

  @MaxLength(255)
  public title_ar!: string;

  @ApiProperty({
    description: 'Lesson description in English',
    example: 'Learn the fundamentals of algebraic expressions and equations.',
    required: false,
  })
  @IsString()
  @IsOptional()
  public description?: string;

  @ApiProperty({
    description: 'Lesson description in Arabic',
    example: 'تعلم أساسيات التعبيرات والمعادلات الجبرية.',
    required: false,
  })
  @IsString()
  @IsOptional()
  public description_ar?: string;

  @ApiProperty({
    description: 'Subject ID this lesson belongs to (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4', { message: 'Subject ID must be a valid UUID' })
  public subject_id!: string;

  @Min(0, { message: 'Price cannot be negative' })
  public price!: number;

  @ApiProperty({
    description: 'Lesson thumbnail URL',
    example: 'https://example.com/thumbnails/lesson1.jpg',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  public thumbnail?: string;

  @ApiProperty({
    description: 'Vimeo video ID (from Vimeo dashboard)',
    example: '123456789',
    required: false,
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  public vimeo_video_id?: string;

  @ApiProperty({
    description: 'Video duration in seconds',
    example: 3600,
    required: false,
    minimum: 0,
  })
  @IsInt()
  @IsOptional()
  @Min(0)
  public duration?: number;

  @ApiProperty({
    description: 'Whether this is a group lesson',
    example: false,
    required: false,
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  public is_group?: boolean;

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
  public available_for_days?: number;
}
