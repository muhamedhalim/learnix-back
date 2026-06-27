import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePackageDto {
  @MaxLength(255)
  public title!: string;

  @MaxLength(255)
  public title_ar!: string;

  @ApiPropertyOptional({
    description: 'Package description in English',
    example: 'A complete package covering all math topics for grade 10',
  })
  @IsOptional()
  @IsString()
  public description?: string;

  @ApiPropertyOptional({
    description: 'Package description in Arabic',
    example: 'حزمة كاملة تغطي جميع موضوعات الرياضيات للصف العاشر',
  })
  @IsOptional()
  @IsString()
  public description_ar?: string;

  @ApiProperty({
    description: 'Package price (must be less than or equal to original_price)',
    example: 99.99,
    minimum: 0,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  public price!: number;

  @ApiPropertyOptional({
    description: 'Thumbnail image URL for the package',
    example: 'https://example.com/thumbnails/math-package.jpg',
  })
  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  public thumbnail?: string;
}
