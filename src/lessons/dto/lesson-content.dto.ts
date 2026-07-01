import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAttachmentDto {
  @ApiProperty({ description: 'Display name', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  public name!: string;

  @ApiProperty({ description: 'Public file URL (from /teacher/uploads)', maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  public url!: string;

  @ApiPropertyOptional({ description: 'pdf | docx | zip | image | pptx | audio | other' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  public type?: string;

  @ApiPropertyOptional({ description: 'Size in bytes' })
  @IsOptional()
  @IsInt()
  @Min(0)
  public size_bytes?: number;
}

export class CreateHomeworkDto {
  @ApiProperty({ description: 'Assignment title', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  public title!: string;

  @ApiPropertyOptional({ description: 'Instructions / description' })
  @IsOptional()
  @IsString()
  public description?: string;

  @ApiPropertyOptional({ description: 'Assignment type (text | file | link | …)' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  public type?: string;

  @ApiPropertyOptional({ description: 'Optional resource URL', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public resource_url?: string;

  @ApiPropertyOptional({ description: 'Due date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  public due_at?: string;
}

export class UpdateHomeworkDto {
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public description?: string;

  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  public type?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public resource_url?: string;

  @ApiPropertyOptional({ description: 'Due date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  public due_at?: string;
}
