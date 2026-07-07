import { ApiProperty } from '@nestjs/swagger';

import { plainToInstance, Transform } from 'class-transformer';
import { IsArray, IsUUID, ValidateNested } from 'class-validator';

import { SaveAnswerItemDto } from './attempt.dto';

/**
 * Submit an OMR answer sheet (multipart: image file + this JSON body). The
 * teacher's scanning tool/workflow has already detected the marks — `answers`
 * mirrors the shape autosave/submit already use (`SaveAnswerItemDto`), so the
 * same per-type response validation applies without duplicating it.
 *
 * `answers` arrives as a JSON-encoded string alongside the multipart file (the
 * only way to send structured data in a multipart body), so it's parsed
 * before class-validator sees it.
 */
export class CreateOmrSheetDto {
  @ApiProperty({ description: 'The student this answer sheet belongs to (UUID)' })
  @IsUUID('4')
  public student_id!: string;

  @ApiProperty({
    type: 'string',
    description: 'JSON-encoded array of SaveAnswerItemDto — the pre-detected marks',
  })
  @Transform(({ value }: { value: unknown }) => {
    // Multipart fields always arrive as strings; parse then instantiate each
    // element as a real SaveAnswerItemDto here (rather than relying on
    // `@Type()` to do it after this transform) so class-validator's
    // `forbidNonWhitelisted` recognizes their declared properties — a plain
    // parsed object is otherwise indistinguishable from an "unknown" shape.
    if (typeof value !== 'string') return value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
    return Array.isArray(parsed) ? plainToInstance(SaveAnswerItemDto, parsed) : parsed;
  })
  @IsArray()
  @ValidateNested({ each: true })
  public answers!: SaveAnswerItemDto[];
}
