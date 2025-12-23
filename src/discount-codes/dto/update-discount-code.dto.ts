import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateDiscountCodeDto } from './create-discount-code.dto';

export class UpdateDiscountCodeDto extends PartialType(
  OmitType(CreateDiscountCodeDto, ['code'] as const),
) {}
