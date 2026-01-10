import {
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttendanceStatus } from '../entities/attendance-record.entity';

export class MarkAttendanceDto {
  @ApiProperty({
    description: 'Student ID (UUID) to mark attendance for',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID()
  @IsNotEmpty()
  student_id!: string;

  @ApiProperty({
    description: 'Lesson ID (UUID)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID()
  @IsNotEmpty()
  lesson_id!: string;

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
