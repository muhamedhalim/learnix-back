import { ApiProperty } from '@nestjs/swagger';

import { IsObject, ValidateIf } from 'class-validator';

/** A teacher's correction for one question on an OMR sheet under review. `response: null` marks it blank. */
export class PatchOmrAnswerDto {
  @ApiProperty({
    type: 'object',
    // @nestjs/swagger v11 requires `properties` or `additionalProperties` on an
    // object-typed @ApiProperty; without one the build fails to type-check.
    // Free-form here by design — the response shape is per question type.
    additionalProperties: true,
    nullable: true,
    description:
      'Corrected response in the same shape autosave/submit use, or null to mark explicitly blank',
  })
  @ValidateIf((o: PatchOmrAnswerDto) => o.response !== null)
  @IsObject()
  public response!: Record<string, unknown> | null;
}
