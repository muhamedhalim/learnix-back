import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

export class AdminDashboardQueryDto {
  @ApiPropertyOptional({ enum: [7, 30], default: 30 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? 30 : Number(value)))
  @IsIn([7, 30])
  public days = 30;
}
