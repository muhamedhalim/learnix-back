import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/**
 * Guardrail (DEF-018): capped well below the platform's own per-question XP
 * range (10–55, see `gamification.constants.ts`) so one teacher's lesson
 * bonus can never dwarf platform-wide scoring.
 */
const MAX_CAMPAIGN_BONUS_XP = 50;

export class CreateGamificationCampaignDto {
  @IsUUID('4')
  public lesson_id!: string;

  @IsString()
  @MaxLength(160)
  public title!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_CAMPAIGN_BONUS_XP)
  public bonus_xp!: number;

  /** Defaults to "now" when omitted. */
  @IsOptional()
  @IsDateString()
  public start_at?: string;

  /** Open-ended when omitted. */
  @IsOptional()
  @IsDateString()
  public end_at?: string;
}

export class UpdateGamificationCampaignDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  public title?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_CAMPAIGN_BONUS_XP)
  public bonus_xp?: number;

  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;

  @IsOptional()
  @IsDateString()
  public start_at?: string;

  @IsOptional()
  @IsDateString()
  public end_at?: string;
}
