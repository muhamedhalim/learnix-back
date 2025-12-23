import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  MaxLength,
  MinLength,
  IsNotEmpty,
} from 'class-validator';

export class ApproveStudentDto {
  @ApiProperty({
    description: 'Optional approval notes',
    example: 'Approved after parent verification',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  notes?: string;
}

export class RejectStudentDto {
  @ApiProperty({
    description: 'Reason for rejection (required)',
    example: 'Invalid parent contact information or incomplete registration',
    maxLength: 1000,
  })
  @IsString()
  @IsNotEmpty({ message: 'Rejection reason is required' })
  @MinLength(10, { message: 'Rejection reason must be at least 10 characters' })
  @MaxLength(1000)
  reason!: string;
}

export class UpdateGradeLevelDto {
  @ApiProperty({
    description: 'New grade level for the student',
    example: 'Grade 11',
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty({ message: 'Grade level is required' })
  @MaxLength(50)
  grade_level!: string;
}
