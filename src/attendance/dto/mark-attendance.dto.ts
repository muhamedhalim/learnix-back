import {
  IsInt,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { AttendanceStatus } from '../entities/attendance-record.entity';

export class MarkAttendanceDto {
  @ApiProperty({
    description: 'Student ID to mark attendance for',
    example: 1,
  })
  @IsInt()
  @IsNotEmpty()
  @Type(() => Number)
  student_id!: number;

  @ApiProperty({
    description: 'Lesson ID',
    example: 1,
  })
  @IsInt()
  @IsNotEmpty()
  @Type(() => Number)
  lesson_id!: number;

  @ApiProperty({
    description: 'Attendance status',
    enum: ['present', 'absent', 'late', 'excused'],
    example: 'present',
  })
  @IsEnum(['present', 'absent', 'late', 'excused'])
  @IsNotEmpty()
  status!: AttendanceStatus;

  @ApiPropertyOptional({
    description: 'Additional notes',
    example: 'Student arrived 10 minutes late',
  })
  @IsString()
  @IsOptional()
  notes?: string;
}
