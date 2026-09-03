import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

import { InstructorEarningStatus, MarketplaceLedgerEntryType } from '../../common/enums';

export class EarningsQueryDto {
  @IsOptional()
  @IsEnum(InstructorEarningStatus)
  status?: InstructorEarningStatus;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class LedgerQueryDto {
  @IsOptional()
  @IsEnum(MarketplaceLedgerEntryType)
  entry_type?: MarketplaceLedgerEntryType;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
