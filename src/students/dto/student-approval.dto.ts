import { ApiProperty } from '@nestjs/swagger';

import { IsOptional, IsString, MaxLength } from 'class-validator';

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
  public notes?: string;
}

export class RejectStudentDto {
  @ApiProperty({
    description: 'Reason for rejection (required)',
    example: 'Invalid parent contact information or incomplete registration',
    maxLength: 1000,
  })
  @MaxLength(1000)
  public reason!: string;
}
