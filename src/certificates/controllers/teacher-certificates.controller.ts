import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Request } from 'express';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { resolveRequestLocale } from '../../i18n/error-translator.util';
import { CertificatesService } from '../certificates.service';

@ApiTags('Teacher · Certificates')
@Controller('teacher/certificates')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherCertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Get('analytics')
  @ApiOperation({ summary: "Certificate analytics for the teacher's courses" })
  public analytics(@GetUser() user: JwtPayload): Promise<unknown> {
    return this.certificatesService.getAnalytics(user.userId);
  }

  @Get('preview/:packageId/pdf')
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Preview a certificate for one of my courses' })
  public async preview(
    @GetUser() user: JwtPayload,
    @Param('packageId', ParseUUIDPipe) packageId: string,
    @Req() request: Request,
  ): Promise<StreamableFile> {
    const pdf = await this.certificatesService.previewForTeacher(
      user.userId,
      packageId,
      undefined,
      resolveRequestLocale(request),
    );
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: 'inline; filename="certificate-preview.pdf"',
    });
  }
}
