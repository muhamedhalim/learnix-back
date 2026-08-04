import { ApiProperty } from '@nestjs/swagger';

import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ApproveSubjectDto {
  @ApiProperty({
    description: 'Optional reviewer note recorded in the audit log',
    required: false,
    maxLength: 1000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  public notes?: string;
}
