import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { AttendanceStatus } from '../entities/attendance-record.entity';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

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
  public status!: AttendanceStatus;

  @ApiPropertyOptional({
    description: 'Additional notes',
    example: 'Student arrived 10 minutes late',
  })
  @IsString()
  @IsOptional()
  public notes?: string;
}
