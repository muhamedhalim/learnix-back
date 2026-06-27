import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsDateString, IsOptional } from 'class-validator';

export class DateRangeQueryDto {
  @ApiPropertyOptional({
    description: 'Start date for the report range (ISO 8601 format)',
    example: '2025-01-01',
  })
  @IsOptional()
  @IsDateString()
  public from?: string;

  @ApiPropertyOptional({
    description: 'End date for the report range (ISO 8601 format)',
    example: '2025-01-31',
  })
  @IsOptional()
  @IsDateString()
  public to?: string;
}
