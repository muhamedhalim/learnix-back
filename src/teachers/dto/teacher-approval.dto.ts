import { ApiProperty } from '@nestjs/swagger';

import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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
  public notes?: string;
}

export class RejectTeacherDto {
  @ApiProperty({
    description: 'Reason for rejection (required)',
    example: 'Insufficient qualifications or missing documentation',
    maxLength: 1000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  public reason!: string;
}
