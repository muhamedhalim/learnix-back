import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class CurriculumItemOrderDto {
  @ApiProperty({ description: 'Lesson ID already in the course' })
  @IsUUID()
  public lesson_id!: string;

  @ApiProperty({ description: 'New order position', minimum: 0 })
  @IsInt()
  @Min(0)
  public order_index!: number;

  @ApiPropertyOptional({
    description: 'Chapter to place the lesson under (null = top-level)',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  public chapter_id?: string | null;
}

export class ChapterOrderDto {
  @ApiProperty({ description: 'Chapter ID' })
  @IsUUID()
  public id!: string;

  @ApiProperty({ description: 'New order position', minimum: 0 })
  @IsInt()
  @Min(0)
  public order_index!: number;
}

/**
 * Persist the whole curriculum order in one request: lesson positions /
 * chapter membership, and (optionally) chapter ordering.
 */
export class ReorderCurriculumDto {
  @ApiProperty({ type: [CurriculumItemOrderDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CurriculumItemOrderDto)
  public items!: CurriculumItemOrderDto[];

  @ApiPropertyOptional({ type: [ChapterOrderDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChapterOrderDto)
  public chapters?: ChapterOrderDto[];
}
