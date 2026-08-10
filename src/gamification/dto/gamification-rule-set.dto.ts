import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Guardrails (DEF-018): every value stays strictly positive and bounded well
 * below any overflow/abuse range — this domain has no concept of a penalty,
 * so negative XP is never accepted. Default (un-overridden) class-validator
 * messages are auto-translated by the existing `VALIDATION_PATTERNS`
 * fallback in `i18n/error-translator.util.ts`.
 */
class XpBaseByDifficultyDto {
  @IsInt()
  @Min(1)
  @Max(2000)
  public easy!: number;

  @IsInt()
  @Min(1)
  @Max(2000)
  public medium!: number;

  @IsInt()
  @Min(1)
  @Max(2000)
  public hard!: number;

  @IsInt()
  @Min(1)
  @Max(2000)
  public expert!: number;
}

class ComboBonusDto {
  /** Combo length that triggers this bonus (e.g. 5, 10, 20). */
  @IsInt()
  @Min(1)
  @Max(100)
  public at!: number;

  @IsInt()
  @Min(1)
  @Max(5000)
  public xp!: number;
}

class StreakMilestoneDto {
  /** Streak length in days that triggers this bonus. */
  @IsInt()
  @Min(1)
  @Max(3650)
  public days!: number;

  @IsInt()
  @Min(1)
  @Max(100000)
  public xp!: number;
}

export class CreateGamificationRuleSetDto {
  @ValidateNested()
  @Type(() => XpBaseByDifficultyDto)
  public xp_base_by_difficulty!: XpBaseByDifficultyDto;

  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ComboBonusDto)
  public combo_bonuses!: ComboBonusDto[];

  @IsInt()
  @Min(0)
  @Max(5000)
  public streak_daily_bonus!: number;

  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => StreakMilestoneDto)
  public streak_milestones!: StreakMilestoneDto[];

  /** Defaults to "now" (immediately current) when omitted. */
  @IsOptional()
  @IsDateString()
  public effective_from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public notes?: string;
}

export class SetGamificationRuleSetEnabledDto {
  @IsBoolean()
  public enabled!: boolean;
}
