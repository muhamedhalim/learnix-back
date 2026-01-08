import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUrl, IsOptional, IsInt, Min } from 'class-validator';

export class UpdateLessonVideoDto {
  @ApiProperty({
    description: 'Bunny.net Stream video URL',
    example: 'https://iframe.mediadelivery.net/embed/123456/abc-def-ghi',
  })
  @IsString()
  @IsUrl()
  video_url!: string;

  @ApiPropertyOptional({
    description: 'Video duration in seconds (optional)',
    example: 3600,
    minimum: 0,
  })
  @IsInt()
  @IsOptional()
  @Min(0)
  duration?: number;
}

export class UpdateVimeoUrlDto {
  @ApiProperty({
    description: 'Vimeo video URL (legacy - use UpdateLessonVideoDto instead)',
    example: 'https://vimeo.com/123456789',
    deprecated: true,
  })
  @IsString()
  @IsUrl()
  video_url!: string;

  @ApiPropertyOptional({
    description: 'Legacy Vimeo URL field (deprecated)',
    example: 'https://vimeo.com/123456789',
    deprecated: true,
  })
  @IsString()
  @IsUrl()
  @IsOptional()
  vimeo_url?: string;

  @ApiPropertyOptional({
    description: 'Video duration in seconds (optional)',
    example: 3600,
    minimum: 0,
  })
  @IsInt()
  @IsOptional()
  @Min(0)
  duration?: number;
}
