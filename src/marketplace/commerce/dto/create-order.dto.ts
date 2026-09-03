import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateMarketplaceOrderDto {
  @IsUUID()
  public courseId!: string;

  /** FR-109: any value here at all is refused — `discountsNotApplicable()` — never silently ignored. */
  @ApiPropertyOptional({ description: 'Not supported for marketplace courses; any value is refused (FR-109)' })
  @IsOptional()
  @IsString()
  public discountCode?: string;
}
