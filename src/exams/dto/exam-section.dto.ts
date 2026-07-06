import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** Create or update an exam section (question group). */
export class UpsertSectionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title_ar?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public description?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  public order_index?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  public shuffle_questions?: boolean;
}
