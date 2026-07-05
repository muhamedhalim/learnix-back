import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { LessonBaseDto } from './lesson-base.dto';

export class CreateLessonDto extends LessonBaseDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  bunny_video_id?: string;
}