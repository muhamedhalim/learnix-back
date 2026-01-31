import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdatePackageDto {
  @ApiPropertyOptional({
    description: 'Package title in English',
    example: 'Complete Math Package',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title?: string;

  @ApiPropertyOptional({
    description: 'Package title in Arabic',
    example: 'حزمة الرياضيات الكاملة',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title_ar?: string;

  @ApiPropertyOptional({
    description: 'Package description in English',
    example: 'A complete package covering all math topics',
  })
  @IsOptional()
  @IsString()
  public description?: string;

  @ApiPropertyOptional({
    description: 'Package description in Arabic',
    example: 'حزمة كاملة تغطي جميع موضوعات الرياضيات',
  })
  @IsOptional()
  @IsString()
  public description_ar?: string;

  @ApiPropertyOptional({
    description: 'Package price',
    example: 99.99,
    minimum: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  public price?: number;

  @ApiPropertyOptional({
    description: 'Whether the package is active and available for purchase',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  public is_active?: boolean;

  @ApiPropertyOptional({
    description: 'Thumbnail image URL',
    example: 'https://example.com/thumbnails/math-package.jpg',
  })
  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  public thumbnail?: string;
}
