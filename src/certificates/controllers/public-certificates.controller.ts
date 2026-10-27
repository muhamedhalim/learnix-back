import { Controller, Get, Header, Param, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { Request } from 'express';

import { THROTTLE } from '../../common/constants';
import { resolveRequestLocale } from '../../i18n/error-translator.util';
import { CertificateStatus } from '../entities/certificate-status.enum';
import type { CertificateTemplateSnapshot } from '../entities/certificate.entity';
import { CertificatesService } from '../certificates.service';
import { CertificateVerificationService } from '../certificate-verification.service';
import { PublicCertificatesFilterDto } from '../dto';

/** Verification lookups are code-guessing targets — tighter than the global cap. */
const VERIFY_THROTTLE = { ttl: 60_000, limit: 20 };

@ApiTags('Certificates')
@Controller('certificates')
export class PublicCertificatesController {
  constructor(
    private readonly certificatesService: CertificatesService,
    private readonly verification: CertificateVerificationService,
  ) {}

  @Get('public')
  @Throttle({ default: THROTTLE.GLOBAL })
  @ApiOperation({
    summary: 'Public achievements gallery (no auth) — only student-published certificates',
  })
  public gallery(@Query() filter: PublicCertificatesFilterDto): Promise<unknown> {
    return this.verification.getPublicCertificates(filter);
  }

  /**
   * Three outcomes, all distinguishable by the caller: an unknown code 404s,
   * a live certificate returns `valid: true`, and a revoked one — including a
   * certificate revoked because the course purchase was fully refunded
   * (DEF-019) — returns `valid: false` with `status: 'revoked'` and the date it
   * lost validity. The historical record is deliberately still served rather
   * than hidden, so a holder of a revoked document gets a definite answer
   * instead of "no such certificate". The reason itself is not published: it
   * can reference an internal refund and is nobody else's business.
   */
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
      revoked_at: Date | null;
      template_snapshot: CertificateTemplateSnapshot | null;
    };
  }> {
    const cert = await this.verification.getByVerificationCode(code);
    const templateSnapshot = await this.certificatesService.getRenderableTemplateSnapshot(cert);
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
        revoked_at: cert.status === CertificateStatus.ISSUED ? null : cert.revoked_at,
        // Formatting only: no IDs, storage paths, or private profile data.
        template_snapshot: templateSnapshot,
      },
    };
  }

  @Get('verify/:code/pdf')
  @Throttle({ default: VERIFY_THROTTLE })
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Download a verified certificate PDF (public)' })
  public async pdf(@Param('code') code: string, @Req() request: Request): Promise<StreamableFile> {
    const cert = await this.verification.getVerifiedCertificateByCode(code);
    const buffer = await this.certificatesService.renderPdf(cert, resolveRequestLocale(request));
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="certificate-${cert.certificate_number}.pdf"`,
    });
  }
}
