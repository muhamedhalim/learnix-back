import { Controller, Post, Body, UseGuards, HttpStatus } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';
import { DiscountCodesService } from '../discount-codes.service';
import { VerifyDiscountCodeDto } from '../dto';

@ApiTags('Discount Codes')
@Controller('discount-codes')
export class DiscountCodesController {
  constructor(private readonly discountCodesService: DiscountCodesService) {}

  @Post('verify')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('student')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Verify a discount code',
    description:
      'Verifies if a discount code is valid for the specified item and calculates the discount amount.',
  })
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
  async verifyCode(
    @Body() dto: VerifyDiscountCodeDto,
    @GetUser() user: JwtPayload,
  ) {
    const result = await this.discountCodesService.verifyCode(dto, user.userId);
    return result;
  }
}
