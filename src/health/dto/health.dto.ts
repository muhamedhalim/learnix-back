import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class HealthHistoryQueryDto {
  @IsOptional()
  @IsIn(['1h', '6h', '24h', '7d', '30d'])
  range: '1h' | '6h' | '24h' | '7d' | '30d' = '24h';

  @IsOptional()
  @IsString()
  components?: string;
}

export class HealthListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit = 25;

  @IsOptional()
  @IsString()
  severity?: string;

  @IsOptional()
  @IsString()
  component?: string;

  @IsOptional()
  @IsString()
  environment?: string;

  @IsOptional()
  @IsString()
  route?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsIn(['open', 'resolved'])
  status?: 'open' | 'resolved';
}

export class UpdateHealthAlertRuleDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  threshold?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(86_400)
  duration_seconds?: number;

  @IsOptional()
  @IsNumber()
  @Min(60)
  @Max(604_800)
  cooldown_seconds?: number;

  @IsOptional()
  @IsIn(['info', 'warning', 'critical'])
  severity?: 'info' | 'warning' | 'critical';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsIn(['in_app', 'email'], { each: true })
  channels?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsEmail({}, { each: true })
  recipients?: string[];
}

export class QueueDiagnosticActionDto {
  @IsBoolean()
  confirm!: boolean;

  @IsIn(['retry_failed', 'clear_completed', 'pause', 'resume'])
  action!: 'retry_failed' | 'clear_completed' | 'pause' | 'resume';
}
