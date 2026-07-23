import {
  Body,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { SubmitManualPaymentDto } from '../dto';
import { ManualPaymentsService } from '../services/manual-payments.service';

@ApiTags('Payments - Manual')
@Controller('payments/manual')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class ManualPaymentsController {
  constructor(private readonly manualPayments: ManualPaymentsService) {}

  @Post('submissions')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('proof', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }),
  )
  public async submit(
    @Body() dto: SubmitManualPaymentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @GetUser() user: JwtPayload,
  ) {
    return {
      data: await this.manualPayments.submit(dto, user.userId, file),
    };
  }

  @Get('submissions')
  public async mine(@GetUser() user: JwtPayload) {
    return { data: await this.manualPayments.listForStudent(user.userId) };
  }
}
