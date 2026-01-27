import { Body, Controller, Get, HttpStatus, Param } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { GetUser } from '../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { AttendanceCodesService } from '../attendance-codes.service';
import { VerifyAttendanceCodeDto } from '../dto';

@ApiTags('Attendance Codes')
@Controller('attendance-codes')
export class AttendanceCodesController {
  constructor(
    private readonly attendanceCodesService: AttendanceCodesService,
  ) {}

  @Get('verify/:code')
  @ApiOperation({
    summary: 'Verify an attendance code (public)',
    description:
      'Check if an attendance code is valid and retrieve its details WITHOUT redeeming it. ' +
      'This endpoint is public and does not require authentication.',
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
  public async verifyCode(@Param('code') code: string): Promise<{
    data: {
      valid: boolean;
      type?: string;
      item_id?: string;
      isExpired?: boolean;
      isUsed?: boolean;
    };
  }> {
    const verification =
      await this.attendanceCodesService.verifyCodePublic(code);
    return {
      data: verification,
    };
  }

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
      item_type: string;
      item_id: string;
    };
  }> {
    const payment = await this.attendanceCodesService.verifyAndRedeem(
      dto,
      user.userId,
    );
    return {
      message:
        'Attendance code redeemed successfully. Access has been granted.',
      data: {
        payment_id: payment.id,
        item_type: payment.item_type,
        item_id: payment.item_id,
      },
    };
  }
}
