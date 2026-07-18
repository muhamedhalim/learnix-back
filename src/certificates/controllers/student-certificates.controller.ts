import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { CertificateVisibilityDto } from '../dto';

@ApiTags('Certificates')
@Controller('student/certificates')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentCertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Get()
  @ApiOperation({ summary: 'List my certificates (history)' })
  public async myCertificates(@GetUser() user: JwtPayload): Promise<{ data: unknown }> {
    const data = await this.certificatesService.getMyCertificates(user.userId);
    return { data };
  }

  @Patch(':id/visibility')
  @ApiOperation({ summary: 'Publish/unpublish my certificate in the public gallery' })
  public setVisibility(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CertificateVisibilityDto,
  ): Promise<unknown> {
    return this.certificatesService.setVisibility(id, user.userId, dto.is_public);
  }

  @Get(':id/pdf')
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Download one of my certificates as a PDF' })
  public async download(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
  ): Promise<StreamableFile> {
    const certificate = await this.certificatesService.getOwnedCertificate(id, user.userId);
    const pdf = await this.certificatesService.renderPdf(
      certificate,
      resolveRequestLocale(request),
    );
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="certificate-${certificate.certificate_number}.pdf"`,
    });
  }
}
