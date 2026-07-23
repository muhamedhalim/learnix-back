import { Body, Controller, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { AttendanceCodesService } from '../attendance-codes.service';
import { VerifyAttendanceCodeDto } from '../dto';

@ApiTags('Attendance Codes')
@Controller('attendance-codes')
@ApiBearerAuth('JWT-auth')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
export class AttendanceCodesController {
  constructor(private readonly attendanceCodesService: AttendanceCodesService) {}

  @Post('verify')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Verify an attendance code (public)',
    description:
      'Check if an attendance code is valid and retrieve its details WITHOUT redeeming it. ' +
      'Authentication is required. The code is sent in the request body so it is not written to URL/access logs.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Code details retrieved successfully',
    schema: {
      example: {
        data: {
          valid: true,
          itemType: 'lesson',
          itemId: 'l_123456',
          itemTitle: 'Physics 101',
          price: 100,
          expiresAt: '2026-12-31T23:59:59.000Z',
          isExpired: false,
          isUsed: false,
        },
      },
    },
  })
  public async verifyCode(@Body() dto: VerifyAttendanceCodeDto): Promise<{
    data: {
      valid: boolean;
      itemType?: 'lesson' | 'package' | 'book' | undefined;
      itemId?: string | undefined;
      itemTitle?: string | undefined;
      price?: number | undefined;
      expiresAt?: Date | undefined;
      isExpired?: boolean | undefined;
      isUsed?: boolean | undefined;
    };
  }> {
    const verification = await this.attendanceCodesService.verifyCodePublic(dto.code);
    return {
      data: verification,
    };
  }

  @Post('redeem')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Redeem an attendance code (student)',
    description: 'Redeems an attendance code and grants access to the associated item.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Invalid or expired code',
  })
  public async redeemCode(
    @Body() dto: VerifyAttendanceCodeDto,
    @GetUser() user: JwtPayload,
  ): Promise<{
    message: string;
    data: {
      payment_id: string;
      order_id: string | null;
      item_type: string;
      item_id: string;
    };
  }> {
    const payment = await this.attendanceCodesService.verifyAndRedeem(dto, user.userId);
    return {
      message: 'Attendance code redeemed successfully. Access has been granted.',
      data: {
        payment_id: payment.id,
        order_id: payment.order_id,
        item_type: payment.item_type,
        item_id: payment.item_id,
      },
    };
  }
}
