import { Controller, Get, Header, Param, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { Request } from 'express';

import { THROTTLE } from '../../common/constants';
import { resolveRequestLocale } from '../../i18n/error-translator.util';
import { CertificateStatus } from '../entities/certificate-status.enum';
import { CertificatesService } from '../certificates.service';
import { PublicCertificatesFilterDto } from '../dto';

/** Verification lookups are code-guessing targets — tighter than the global cap. */
const VERIFY_THROTTLE = { ttl: 60_000, limit: 20 };

@ApiTags('Certificates')
@Controller('certificates')
export class PublicCertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Get('public')
  @Throttle({ default: THROTTLE.GLOBAL })
  @ApiOperation({
    summary: 'Public achievements gallery (no auth) — only student-published certificates',
  })
  public gallery(@Query() filter: PublicCertificatesFilterDto): Promise<unknown> {
    return this.certificatesService.getPublicCertificates(filter);
  }

  @Get('verify/:code')
  @Throttle({ default: VERIFY_THROTTLE })
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
  @Throttle({ default: VERIFY_THROTTLE })
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Download a verified certificate PDF (public)' })
  public async pdf(@Param('code') code: string, @Req() request: Request): Promise<StreamableFile> {
    const cert = await this.certificatesService.getVerifiedCertificateByCode(code);
    const buffer = await this.certificatesService.renderPdf(cert, resolveRequestLocale(request));
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="certificate-${cert.certificate_number}.pdf"`,
    });
  }
}
