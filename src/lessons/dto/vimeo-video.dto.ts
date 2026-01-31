import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateVimeoInfoDto {
  @ApiProperty({
    description: 'Vimeo video ID (from Vimeo dashboard)',
    example: '123456789',
    maxLength: 255,
  })
  @MaxLength(255)
  public vimeo_video_id!: string;

  @ApiProperty({
    description: 'Vimeo embed URL (auto-generated if not provided)',
    example: 'https://player.vimeo.com/video/123456789',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  public vimeo_embed_url?: string;

  @ApiProperty({
    description: 'Video duration in seconds',
    example: 3600,
    required: false,
    minimum: 0,
  })
  @IsInt()
  @IsOptional()
  @Min(0)
  public duration?: number;
}
