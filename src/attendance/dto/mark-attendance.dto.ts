import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import type { AttendanceStatus } from '../entities/attendance-record.entity';

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'] as const;

export class MarkAttendanceDto {
  @ApiProperty({
    description: 'Student ID (UUID) to mark attendance for',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsNotEmpty()
  public student_id!: string;

  @ApiProperty({
    description: 'Lesson ID (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsNotEmpty()
  public lesson_id!: string;

  @IsNotEmpty()
  @IsIn(ATTENDANCE_STATUSES)
  public status!: AttendanceStatus;

  @ApiPropertyOptional({
    description: 'Additional notes',
    example: 'Student arrived 10 minutes late',
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  public notes?: string;
}
