import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationDto } from '../../common/dto/pagination.dto';
import type { UploadFolderType } from '../entities/uploaded-file.entity';

const FILE_FOLDERS: UploadFolderType[] = ['resources', 'thumbnails', 'profiles'];

export class FileListQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Filter by upload folder',
    enum: FILE_FOLDERS,
  })
  @IsOptional()
  @IsIn(FILE_FOLDERS)
  public folder?: UploadFolderType;

  @ApiPropertyOptional({
    description: 'Search generated or original filenames',
    maxLength: 255,
  })
  @IsOptional()
  @Transform(({ value }): unknown => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(255)
  public search?: string;
}

export class AdminFileListQueryDto extends FileListQueryDto {
  @ApiProperty({
    description: 'User whose files should be listed',
    format: 'uuid',
  })
  @IsUUID()
  public userId!: string;
}
