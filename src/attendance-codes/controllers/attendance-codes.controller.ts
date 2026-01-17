import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpStatus,
  Get,
  Param,
} from '@nestjs/common';
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
  async verifyCode(@Param('code') code: string) {
    const verification =
      await this.attendanceCodesService.verifyCodePublic(code);
    return {
      data: verification,
    };
  }

  @Post('redeem')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('student')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Redeem an attendance code',
    description:
      'Redeems an attendance code to grant free access to a lesson or package.',
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
    @Body() dto: VerifyAttendanceCodeDto,
    @GetUser() user: JwtPayload,
  ) {
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
