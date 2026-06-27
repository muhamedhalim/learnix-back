import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateBookDto {
  @MaxLength(255)
  public title!: string;

  @MaxLength(255)
  public title_ar!: string;

  @ApiPropertyOptional({
    description: 'Book description in English',
    example: 'A comprehensive guide to basic mathematics',
  })
  @IsString()
  @IsOptional()
  public description?: string;

  @ApiPropertyOptional({
    description: 'Book description in Arabic',
    example: 'دليل شامل لأساسيات الرياضيات',
  })
  @IsString()
  @IsOptional()
  public description_ar?: string;

  @ApiProperty({
    description: 'Subject ID the book belongs to (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsNotEmpty()
  public subject_id!: string;

  @ApiPropertyOptional({
    description: 'Cover image URL (from upload)',
    example: '/uploads/thumbnails/book-cover.jpg',
  })
  @IsString()
  @IsOptional()
  public cover_image?: string;

  @ApiProperty({
    description: 'Book file URL (PDF from upload)',
    example: '/uploads/resources/book.pdf',
  })
  @IsNotEmpty()
  public book_file!: string;

  @ApiProperty({
    description: 'Book price in EGP',
    example: 150,
    minimum: 0,
  })
  @IsNumber()
  @IsNotEmpty()
  @Min(0)
  @Type(() => Number)
  public price!: number;
}
