import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsDateString, IsOptional } from 'class-validator';

export class UpdateAttendanceCodeDto {
  @ApiPropertyOptional({
    description: 'New expiration date for the code',
    example: '2025-12-31T23:59:59.000Z',
  })
  @IsOptional()
  @IsDateString()
  public expires_at?: string;
}
