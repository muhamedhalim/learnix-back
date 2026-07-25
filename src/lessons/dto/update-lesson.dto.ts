import { PartialType } from '@nestjs/swagger';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

import { LessonBaseDto } from './lesson-base.dto';
export class UpdateLessonDto extends PartialType(LessonBaseDto) {
  @ApiPropertyOptional({ description: 'Current lesson version, for optimistic concurrency control.' })
  @IsInt()
  @IsOptional()
  @Min(1)
  version?: number;
}
