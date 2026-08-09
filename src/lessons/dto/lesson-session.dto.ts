import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class CreateLessonSessionSlotDto {
  @IsDateString()
  public start_at!: string;

  @IsOptional()
  @IsDateString()
  public end_at?: string;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  public meeting_url?: string;
}

export class CreateLessonSessionsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateLessonSessionSlotDto)
  public sessions!: CreateLessonSessionSlotDto[];
}

export class UpdateLessonSessionDto {
  @IsOptional()
  @IsDateString()
  public start_at?: string;

  @IsOptional()
  @IsDateString()
  public end_at?: string;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  public meeting_url?: string;
}

export class CancelLessonSessionDto {
  @IsString()
  @MaxLength(1000)
  public reason!: string;
}

export class ReserveLessonSessionDto {
  @IsUUID('4')
  public session_id!: string;
}
