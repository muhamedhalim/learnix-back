import { Body, Controller, HttpStatus } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';

import { GetUser } from '../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { DiscountCodesService } from '../discount-codes.service';
import { VerifyDiscountCodeDto } from '../dto';

@ApiTags('Discount Codes')
@Controller('discount-codes')
export class DiscountCodesController {
  constructor(private readonly discountCodesService: DiscountCodesService) {}

  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Discount code verification result',
    schema: {
      type: 'object',
      properties: {
        valid: { type: 'boolean' },
        error: { type: 'string', nullable: true },
        discount_code_id: { type: 'number', nullable: true },
        discount_type: { type: 'string', nullable: true },
        discount_value: { type: 'number', nullable: true },
        discount_amount: { type: 'number', nullable: true },
        final_amount: { type: 'number', nullable: true },
      },
    },
  })
  public async verifyCode(
    @Body() dto: VerifyDiscountCodeDto,
    @GetUser() user: JwtPayload,
  ): Promise<{
    valid: boolean;
    error?: string;
    discount_code_id?: string;
    discount_type?: string;
    discount_value?: number;
    discount_amount?: number;
    final_amount?: number;
  }> {
    const result = await this.discountCodesService.verifyCode(dto, user.userId);
    return result;
  }
}
