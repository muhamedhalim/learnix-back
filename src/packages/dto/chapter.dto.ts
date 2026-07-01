import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateChapterDto {
  @ApiProperty({ description: 'Chapter title', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  public title!: string;

  @ApiPropertyOptional({ description: 'Order position', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  public order_index?: number;
}

export class UpdateChapterDto {
  @ApiPropertyOptional({ description: 'Chapter title', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title?: string;

  @ApiPropertyOptional({ description: 'Order position', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  public order_index?: number;
}
