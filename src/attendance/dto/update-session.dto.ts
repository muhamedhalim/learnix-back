import { ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

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
  public video_progress_percent?: number;

  @ApiPropertyOptional({
    description: 'Total watch duration in seconds',
    example: 1800,
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  public duration_seconds?: number;
}
