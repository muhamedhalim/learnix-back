import { ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

import { ParentEventType } from '../../common/events/parent-event-type.enum';
import { MessageChannel, ParentMessageStatus } from '../entities';

export class ParentMessageFilterDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number;

  // `enum:` is required here — a bare `type: String` renders the query param as
  // a free-text box in Swagger and silently drops the enum contract.
  @ApiPropertyOptional({ enum: ParentMessageStatus })
  @IsOptional()
  @IsEnum(ParentMessageStatus)
  public status?: ParentMessageStatus;

  @ApiPropertyOptional({ enum: ParentEventType })
  @IsOptional()
  @IsEnum(ParentEventType)
  public event_type?: ParentEventType;

  @ApiPropertyOptional({ enum: MessageChannel })
  @IsOptional()
  @IsEnum(MessageChannel)
  public channel?: MessageChannel;

  @ApiPropertyOptional({ description: 'Filter to one student' })
  @IsOptional()
  @IsUUID()
  public student_id?: string;

  @ApiPropertyOptional({ description: 'Filter to one guardian' })
  @IsOptional()
  @IsUUID()
  public guardian_id?: string;

  @ApiPropertyOptional({ description: 'Search the rendered body' })
  @IsOptional()
  @IsString()
  public search?: string;
}
