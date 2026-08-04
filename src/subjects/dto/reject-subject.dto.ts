import { ApiProperty } from '@nestjs/swagger';

import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectSubjectDto {
  @ApiProperty({
    description: 'Why the subject was rejected. Shown to the owning teacher.',
    example: 'Duplicate of an existing subject — please use "Physics" instead.',
    maxLength: 1000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  public reason!: string;
}
