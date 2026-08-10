import { ApiProperty } from '@nestjs/swagger';

import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

/** Generate (or idempotently reuse) one OMR answer sheet per selected student. */
export class GenerateOmrSheetsDto {
  @ApiProperty({ type: [String], description: 'Students to generate answer sheets for' })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  public student_ids!: string[];
}
