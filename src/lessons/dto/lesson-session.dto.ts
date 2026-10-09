import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { MeetingProvider } from '../entities/meeting-provider.enum';

/** `GET /student/lesson-sessions`: optionally narrow the caller's own bookings to one lesson (T088). */
export class StudentLessonSessionsQueryDto {
  @IsOptional()
  @IsUUID()
  public lesson_id?: string;
}

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

  /**
   * Stored on the slot for the teacher to Generate later (Phase 5, AD-7) —
   * never acted on at create time. Ignored when `meeting_url` is also set,
   * since a manual link makes the slot `ready` immediately.
   */
  @IsOptional()
  @IsEnum(MeetingProvider)
  public meeting_provider?: MeetingProvider;
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

  /** Rejected while a meeting exists or is being created (R-17) — clear it first via DELETE .../meeting. */
  @IsOptional()
  @IsEnum(MeetingProvider)
  public meeting_provider?: MeetingProvider;
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

/** Optional body for `POST .../sessions/:sessionId/meeting` — overrides the slot's stored provider for this call. */
export class GenerateSessionMeetingDto {
  @IsOptional()
  @IsEnum(MeetingProvider)
  public meeting_provider?: MeetingProvider;
}
