import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
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
    description: 'Subject ID the book belongs to',
    example: 1,
  })
  @IsInt()
  @IsNotEmpty()
  @Type(() => Number)
  subject_id!: number;

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
