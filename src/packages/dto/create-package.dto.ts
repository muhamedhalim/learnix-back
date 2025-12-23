import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  Min,
  MaxLength,
  IsUrl,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePackageDto {
  @ApiProperty({
    description: 'Package title in English',
    example: 'Complete Math Package',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @ApiProperty({
    description: 'Package title in Arabic',
    example: 'حزمة الرياضيات الكاملة',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title_ar!: string;

  @ApiPropertyOptional({
    description: 'Package description in English',
    example: 'A complete package covering all math topics for grade 10',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Package description in Arabic',
    example: 'حزمة كاملة تغطي جميع موضوعات الرياضيات للصف العاشر',
  })
  @IsOptional()
  @IsString()
  description_ar?: string;

  @ApiProperty({
    description: 'Package price (must be less than or equal to original_price)',
    example: 99.99,
    minimum: 0,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  price!: number;

  @ApiPropertyOptional({
    description: 'Thumbnail image URL for the package',
    example: 'https://example.com/thumbnails/math-package.jpg',
  })
  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  thumbnail?: string;
}
