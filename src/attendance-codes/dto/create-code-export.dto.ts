import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsOptional, ValidateNested } from 'class-validator';

import { CodeExportFormat } from '../entities/code-export-format.enum';
import { PdfLayout } from '../entities/pdf-layout.enum';
import { CodeSelectionDto } from './code-selection.dto';

/**
 * Request an asynchronous export/print job over a filtered set of codes.
 * `layout` applies only to PDF/QR formats; it is ignored for data exports.
 */
export class CreateCodeExportDto {
  @ApiProperty({ enum: CodeExportFormat, description: 'Output format' })
  @IsEnum(CodeExportFormat)
  public format!: CodeExportFormat;

  @ApiPropertyOptional({
    enum: PdfLayout,
    description: 'Print layout (PDF/QR only). Defaults to A4 grid / QR sheet.',
  })
  @IsOptional()
  @IsEnum(PdfLayout)
  public layout?: PdfLayout;

  @ApiPropertyOptional({
    type: CodeSelectionDto,
    description: 'Which codes to export (same filters as the codes table).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CodeSelectionDto)
  public filters?: CodeSelectionDto;
}
