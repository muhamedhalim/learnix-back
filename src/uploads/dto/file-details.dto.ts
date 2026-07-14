import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FileReferenceDto {
  @ApiProperty({
    description: 'Entity type that references this file',
    enum: ['lesson', 'book', 'user', 'teacher'],
  })
  public entityType!: 'lesson' | 'book' | 'user' | 'teacher';

  @ApiProperty({ description: 'Entity ID' })
  public entityId!: string;

  @ApiProperty({ description: 'Field name referencing the file' })
  public field!: string;

  @ApiPropertyOptional({ description: 'Entity title or name' })
  public entityTitle?: string;
}

export class FileUsageDto {
  @ApiProperty({ description: 'Filename' })
  public filename!: string;

  @ApiProperty({ description: 'Whether the file is currently in use' })
  public isInUse!: boolean;

  @ApiProperty({
    type: [FileReferenceDto],
    description: 'Entities using this file',
  })
  public usedIn!: FileReferenceDto[];
}

export class FileDetailsDto {
  @ApiProperty({ description: 'File ID (UUID)' })
  public id!: string;

  @ApiProperty({ description: 'Generated filename' })
  public filename!: string;

  @ApiProperty({ description: 'Original filename when uploaded' })
  public originalFilename!: string;

  @ApiProperty({
    description: 'Upload folder',
    enum: ['resources', 'thumbnails', 'profiles'],
  })
  public folder!: string;

  @ApiProperty({ description: 'MIME type' })
  public mimeType!: string;

  @ApiProperty({ description: 'File size in bytes' })
  public size!: number;

  @ApiProperty({ description: 'Upload timestamp' })
  public uploadedAt!: Date;

  @ApiProperty({
    type: [FileReferenceDto],
    description: 'Entities using this file',
  })
  public usedIn!: FileReferenceDto[];
}

export class FileListResponseDto {
  @ApiProperty({ type: [FileDetailsDto], description: 'List of files' })
  public data!: FileDetailsDto[];

  @ApiProperty({
    description: 'Pagination metadata',
    example: { page: 1, limit: 10, total: 42, totalPages: 5 },
  })
  public meta!: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export class FileDeleteResponseDto {
  @ApiProperty({ description: 'Success message' })
  public message!: string;
}
