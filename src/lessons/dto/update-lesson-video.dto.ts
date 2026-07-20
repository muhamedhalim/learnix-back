import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsInt, IsOptional, IsString, Min } from 'class-validator';

import { IsSecureUrl } from '../../common/validators/secure-url.validator';

export class UpdateLessonVideoDto {
  @IsSecureUrl()
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
  @IsSecureUrl()
  public video_url!: string;

  @ApiPropertyOptional({
    description: 'Legacy Vimeo URL field (deprecated)',
    example: 'https://vimeo.com/123456789',
    deprecated: true,
  })
  @IsString()
  @IsSecureUrl()
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
