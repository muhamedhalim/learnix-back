import { ApiProperty } from '@nestjs/swagger';

import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Subject management intentionally accepts one locale-neutral display name. */
export class UpdateSubjectDto {
  @ApiProperty({
    description: 'Subject name in the creator’s preferred language',
    example: 'Mathematics',
    required: false,
    maxLength: 255,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(255)
  public name?: string;
}
