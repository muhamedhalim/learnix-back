import { IsNumber, IsInt, IsOptional, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class UpdateSessionDto {
  @ApiPropertyOptional({
    description: 'Video watch percentage (0-100)',
    example: 85.5,
    minimum: 0,
    maximum: 100,
  })
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  @Type(() => Number)
  watch_percentage?: number;

  @ApiPropertyOptional({
    description: 'Total watch duration in seconds',
    example: 1800,
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  duration_seconds?: number;
}
