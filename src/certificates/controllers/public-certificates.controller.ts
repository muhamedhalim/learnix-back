import { Controller, Get, Header, Param, Req, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Request } from 'express';

import { resolveRequestLocale } from '../../i18n/error-translator.util';
import { CertificateStatus } from '../entities/certificate-status.enum';
import { CertificatesService } from '../certificates.service';

@ApiTags('Certificates')
@Controller('certificates')
export class PublicCertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Get('verify/:code')
  @ApiOperation({ summary: 'Verify a certificate by its code (public)' })
  public async verify(@Param('code') code: string): Promise<{
    valid: boolean;
    certificate: {
      certificate_number: string;
      student_name: string;
      course_title: string;
      teacher_name: string | null;
      completion_percentage: number;
      issued_at: Date;
      status: CertificateStatus;
    };
  }> {
    const cert = await this.certificatesService.getByVerificationCode(code);
    return {
      valid: cert.status === CertificateStatus.ISSUED,
      certificate: {
        certificate_number: cert.certificate_number,
        student_name: cert.student_name,
        course_title: cert.course_title,
        teacher_name: cert.teacher_name,
        completion_percentage: cert.completion_percentage,
        issued_at: cert.issued_at,
        status: cert.status,
      },
    };
  }

  @Get('verify/:code/pdf')
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Download a verified certificate PDF (public)' })
  public async pdf(@Param('code') code: string, @Req() request: Request): Promise<StreamableFile> {
    const cert = await this.certificatesService.getByVerificationCode(code);
    const buffer = await this.certificatesService.renderPdf(cert, resolveRequestLocale(request));
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="certificate-${cert.certificate_number}.pdf"`,
    });
  }
}
