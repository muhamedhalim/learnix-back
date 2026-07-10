import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { CertificatesService } from '../certificates.service';

@ApiTags('Certificates')
@Controller('student/certificates')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentCertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Get()
  @ApiOperation({ summary: 'List my certificates (history)' })
  public async myCertificates(
    @GetUser() user: JwtPayload,
  ): Promise<{ data: unknown }> {
    const data = await this.certificatesService.getMyCertificates(user.userId);
    return { data };
  }

  @Get(':id/pdf')
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Download one of my certificates as a PDF' })
  public async download(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const certificate = await this.certificatesService.getOwnedCertificate(
      id,
      user.userId,
    );
    const pdf = await this.certificatesService.renderPdf(certificate);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="certificate-${certificate.certificate_number}.pdf"`,
    });
  }
}
