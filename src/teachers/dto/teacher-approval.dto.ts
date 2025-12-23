import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  MaxLength,
  MinLength,
  IsNotEmpty,
} from 'class-validator';

export class ApproveTeacherDto {
  @ApiProperty({
    description: 'Optional approval notes',
    example: 'Approved after verification of credentials',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  notes?: string;
}

export class RejectTeacherDto {
  @ApiProperty({
    description: 'Reason for rejection (required)',
    example: 'Insufficient qualifications or missing documentation',
    maxLength: 1000,
  })
  @IsString()
  @IsNotEmpty({ message: 'Rejection reason is required' })
  @MinLength(10, { message: 'Rejection reason must be at least 10 characters' })
  @MaxLength(1000)
  reason!: string;
}
