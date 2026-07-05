import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationDto } from '../../common/dto/pagination.dto';
import { CodeExportFormat } from '../entities/code-export-format.enum';
import { CodeExportStatus } from '../entities/code-export-status.enum';

/** Filters for listing export jobs. */
export class CodeExportFilterDto extends PaginationDto {
  @ApiPropertyOptional({ enum: CodeExportStatus })
  @IsOptional()
  @IsEnum(CodeExportStatus)
  public status?: CodeExportStatus;

  @ApiPropertyOptional({ enum: CodeExportFormat })
  @IsOptional()
  @IsEnum(CodeExportFormat)
  public format?: CodeExportFormat;

  @ApiPropertyOptional({ description: 'Filter by batch ID' })
  @IsOptional()
  @IsUUID('4')
  public batch_id?: string;
}
