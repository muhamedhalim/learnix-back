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
import { PurchaseCodesService } from '../purchase-codes.service';
import { VerifyPurchaseCodeDto } from '../dto';

@ApiTags('Purchase Codes')
@Controller('purchase-codes')
export class PurchaseCodesController {
  constructor(private readonly purchaseCodesService: PurchaseCodesService) {}

  @Post('redeem')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('student')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Redeem a purchase code',
    description:
      'Redeems a purchase code to grant free access to a lesson or package.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Code redeemed successfully, access granted',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Invalid or expired code',
  })
  async redeemCode(
    @Body() dto: VerifyPurchaseCodeDto,
    @GetUser() user: JwtPayload,
  ) {
    const payment = await this.purchaseCodesService.verifyAndRedeem(
      dto,
      user.userId,
    );
    return {
      message: 'Purchase code redeemed successfully. Access has been granted.',
      data: {
        payment_id: payment.id,
        item_type: payment.item_type,
        item_id: payment.item_id,
      },
    };
  }
}
