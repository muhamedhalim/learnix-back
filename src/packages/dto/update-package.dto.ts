import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  Min,
  MaxLength,
  IsUrl,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdatePackageDto {
  @ApiPropertyOptional({
    description: 'Package title in English',
    example: 'Complete Math Package',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({
    description: 'Package title in Arabic',
    example: 'حزمة الرياضيات الكاملة',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title_ar?: string;

  @ApiPropertyOptional({
    description: 'Package description in English',
    example: 'A complete package covering all math topics',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Package description in Arabic',
    example: 'حزمة كاملة تغطي جميع موضوعات الرياضيات',
  })
  @IsOptional()
  @IsString()
  description_ar?: string;

  @ApiPropertyOptional({
    description: 'Package price',
    example: 99.99,
    minimum: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  price?: number;

  @ApiPropertyOptional({
    description: 'Whether the package is active and available for purchase',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  is_active?: boolean;

  @ApiPropertyOptional({
    description: 'Thumbnail image URL',
    example: 'https://example.com/thumbnails/math-package.jpg',
  })
  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  thumbnail?: string;
}
