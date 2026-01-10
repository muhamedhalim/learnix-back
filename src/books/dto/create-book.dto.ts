import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsNumber,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateBookDto {
  @ApiProperty({
    description: 'Book title in English',
    example: 'Introduction to Mathematics',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @ApiProperty({
    description: 'Book title in Arabic',
    example: 'مقدمة في الرياضيات',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title_ar!: string;

  @ApiPropertyOptional({
    description: 'Book description in English',
    example: 'A comprehensive guide to basic mathematics',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Book description in Arabic',
    example: 'دليل شامل لأساسيات الرياضيات',
  })
  @IsString()
  @IsOptional()
  description_ar?: string;

  @ApiProperty({
    description: 'Subject ID the book belongs to (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4', { message: 'Subject ID must be a valid UUID' })
  @IsNotEmpty()
  subject_id!: string;

  @ApiPropertyOptional({
    description: 'Cover image URL (from upload)',
    example: '/uploads/thumbnails/book-cover.jpg',
  })
  @IsString()
  @IsOptional()
  cover_image?: string;

  @ApiProperty({
    description: 'Book file URL (PDF from upload)',
    example: '/uploads/resources/book.pdf',
  })
  @IsString()
  @IsNotEmpty()
  book_file!: string;

  @ApiProperty({
    description: 'Book price in EGP',
    example: 150.0,
    minimum: 0,
  })
  @IsNumber()
  @IsNotEmpty()
  @Min(0)
  @Type(() => Number)
  price!: number;
}
