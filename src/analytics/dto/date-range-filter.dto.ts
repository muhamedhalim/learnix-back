import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';

export class DateRangeFilterDto {
  @ApiPropertyOptional({
    description: 'Start date for analytics period (ISO 8601 format)',
    example: '2025-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  @Transform(({ value }: { value: string | undefined }) =>
    value ? new Date(value) : undefined,
  )
  startDate?: Date;

  @ApiPropertyOptional({
    description: 'End date for analytics period (ISO 8601 format)',
    example: '2025-12-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString()
  @Transform(({ value }: { value: string | undefined }) =>
    value ? new Date(value) : undefined,
  )
  endDate?: Date;

  getDateRange(): { startDate: Date; endDate: Date } {
    const endDate = this.endDate || new Date();
    const startDate =
      this.startDate || new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000); // Default 30 days
    return { startDate, endDate };
  }
}
