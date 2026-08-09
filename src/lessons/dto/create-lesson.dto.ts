import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, ValidateNested } from 'class-validator';

import { LessonBaseDto } from './lesson-base.dto';
import { CreateLessonSessionSlotDto } from './lesson-session.dto';

export class CreateLessonDto extends LessonBaseDto {
  @ApiProperty({ required: false, type: [CreateLessonSessionSlotDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateLessonSessionSlotDto)
  public session_slots?: CreateLessonSessionSlotDto[];
}
