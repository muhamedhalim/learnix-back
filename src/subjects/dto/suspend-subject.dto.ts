import { ApiProperty } from '@nestjs/swagger';

import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SuspendSubjectDto {
  @ApiProperty({
    description: 'Why the subject was suspended. Shown to the owning teacher.',
    example: 'Reported as misleading; pending review with the content team.',
    maxLength: 1000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  public reason!: string;
}
