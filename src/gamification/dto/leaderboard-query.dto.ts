import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';

export enum LeaderboardScope {
  GLOBAL = 'global',
  SUBJECT = 'subject',
  GRADE = 'grade',
  GOVERNORATE = 'governorate',
}

export enum LeaderboardWindow {
  ALL_TIME = 'all_time',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
}

export enum LeaderboardMetric {
  RATING = 'rating',
  XP = 'xp',
}

/**
 * Public-exam leaderboard query. Weekly/monthly windows use the attempt's
 * grading timestamp. `metric` remains accepted for backward compatibility,
 * but public-exam percentage is the sole ranking score.
 */
export class LeaderboardQueryDto {
  @ApiPropertyOptional({ enum: LeaderboardScope, default: LeaderboardScope.GLOBAL })
  @IsOptional()
  @IsEnum(LeaderboardScope)
  public scope: LeaderboardScope = LeaderboardScope.GLOBAL;

  @ApiPropertyOptional({ enum: LeaderboardWindow, default: LeaderboardWindow.ALL_TIME })
  @IsOptional()
  @IsEnum(LeaderboardWindow)
  public window: LeaderboardWindow = LeaderboardWindow.ALL_TIME;

  @ApiPropertyOptional({ enum: LeaderboardMetric, default: LeaderboardMetric.RATING })
  @IsOptional()
  @IsEnum(LeaderboardMetric)
  public metric: LeaderboardMetric = LeaderboardMetric.RATING;

  @ApiPropertyOptional({ description: 'Required when scope=subject' })
  @IsOptional()
  @IsUUID('4')
  public subject_id?: string;

  @ApiPropertyOptional({ description: 'Required when scope=grade' })
  @IsOptional()
  @IsString()
  public grade_level?: string;

  @ApiPropertyOptional({ description: 'Required when scope=governorate' })
  @IsOptional()
  @IsString()
  public governorate?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  public page = 1;

  @ApiPropertyOptional({ default: 25, maximum: 100 })
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  @Max(100)
  public limit = 25;
}
