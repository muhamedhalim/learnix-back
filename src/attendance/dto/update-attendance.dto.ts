import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import type { AttendanceStatus } from '../entities/attendance-record.entity';
import { ATTENDANCE_STATUSES } from './mark-attendance.dto';

export class UpdateAttendanceDto {
  @ApiProperty({ enum: ATTENDANCE_STATUSES })
  @IsIn(ATTENDANCE_STATUSES)
  public status!: AttendanceStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public notes?: string;
}
