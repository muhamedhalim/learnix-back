import { PartialType } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { LessonBaseDto } from './lesson-base.dto';
import { LessonStatus } from '../entities/lesson-status.enum';

export class UpdateLessonDto extends PartialType(LessonBaseDto) {
  @ApiProperty({
    enum: LessonStatus,
    required: false,
  })
  @IsEnum(LessonStatus)
  @IsOptional()
  status?: LessonStatus;
}