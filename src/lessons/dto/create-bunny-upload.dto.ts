import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateBunnyUploadDto {
  @ApiPropertyOptional({
    description:
      'Optional title for the Bunny Stream video. Defaults to the lesson title.',
    maxLength: 200,
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  public title?: string;
}
