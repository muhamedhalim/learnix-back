import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsInt, IsOptional, IsString, IsUrl, Min } from 'class-validator';

export class UpdateLessonVideoDto {
  @IsUrl()
  public video_url!: string;

  @ApiPropertyOptional({
    description: 'Video duration in seconds (optional)',
    example: 3600,
    minimum: 0,
  })
  @IsInt()
  @IsOptional()
  @Min(0)
  public duration?: number;
}

export class UpdateVimeoUrlDto {
  @ApiProperty({
    description: 'Vimeo video URL (legacy - use UpdateLessonVideoDto instead)',
    example: 'https://vimeo.com/123456789',
    deprecated: true,
  })
  @IsUrl()
  public video_url!: string;

  @ApiPropertyOptional({
    description: 'Legacy Vimeo URL field (deprecated)',
    example: 'https://vimeo.com/123456789',
    deprecated: true,
  })
  @IsString()
  @IsUrl()
  @IsOptional()
  public vimeo_url?: string;

  @ApiPropertyOptional({
    description: 'Video duration in seconds (optional)',
    example: 3600,
    minimum: 0,
  })
  @IsInt()
  @IsOptional()
  @Min(0)
  public duration?: number;
}
