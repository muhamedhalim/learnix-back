import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

import { MarketplaceCommissionScope } from '../../common/enums';

/** FR-136, FR-285 — only `PLATFORM` scope is ever resolved today (see `MarketplaceCommissionService`'s own doc comment); the field stays open for the reserved scopes rather than hard-coding platform-only. */
export class SetCommissionRateDto {
  @IsEnum(MarketplaceCommissionScope)
  scope!: MarketplaceCommissionScope;

  @IsOptional()
  @IsString()
  scopeRefId?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsInt()
  @Min(0)
  @Max(10000)
  rateBps!: number;
}
