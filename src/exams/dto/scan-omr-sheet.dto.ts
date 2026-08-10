import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsOptional, IsUUID } from 'class-validator';

/**
 * Submit a scanned/photographed answer sheet image (multipart: `file` + this
 * JSON body). Deliberately carries NO answer data — the whole point of
 * DEF-004 is that the image itself is the source of the detected answers,
 * not the client. `sheet_id`/`student_id` only resolve WHICH sheet the image
 * belongs to; if both are omitted, the sheet's own identity QR resolves it.
 */
export class ScanOmrSheetDto {
  @ApiPropertyOptional({
    description: 'Bind to an already-generated sheet (from POST .../generate)',
  })
  @IsOptional()
  @IsUUID('4')
  public sheet_id?: string;

  @ApiPropertyOptional({
    description:
      'Manual fallback: the student this scan belongs to, when no pre-generated sheet/QR identifies it',
  })
  @IsOptional()
  @IsUUID('4')
  public student_id?: string;
}
