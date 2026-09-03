import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Request } from 'express';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { CertificatesService } from '../../../certificates/certificates.service';
import type { Certificate } from '../../../certificates/entities/certificate.entity';
import { CertificateVisibilityDto } from '../../../certificates/dto';
import { Pagination20Dto } from '../../../common/dto/pagination.dto';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import type { PaginationMeta } from '../../../common/interfaces/pagination.interface';
import { resolveRequestLocale } from '../../../i18n/error-translator.util';

/**
 * Contracts §4: `GET /marketplace/me/certificates` plus the same
 * visibility-toggle and PDF-download actions `StudentCertificatesController`
 * offers academically. That controller cannot be reused as-is for any of
 * the three: it is gated `@Controller`-wide `@Roles('student')`, but a
 * marketplace learner is any authenticated user (a teacher or admin can
 * enroll too, same as anyone can apply to become an instructor — FR-009) —
 * reusing it would 403 exactly the accounts these routes most need to work
 * for. Every method here delegates to the exact same `CertificatesService`
 * methods the academic controller calls (`getMyCertificates`, `setVisibility`,
 * `getOwnedDownloadableCertificate`, `renderPdf`) — all already scoped by
 * `student_id`, not by role, so nothing about the underlying authorization
 * changes; only the route's own guard does.
 */
@ApiTags('Marketplace / Learning')
@Controller('marketplace/me/certificates')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class LearnerCertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get()
  @ApiOperation({ summary: 'My marketplace certificates (FR-252 — never mixed with academic ones)' })
  public async myCertificates(
    @GetUser() user: JwtPayload,
    @Query() pagination: Pagination20Dto,
  ): Promise<{ data: Certificate[]; meta: PaginationMeta }> {
    return this.certificates.getMyCertificates(user.userId, pagination.page, pagination.limit, 'marketplace');
  }

  @Patch(':id/visibility')
  @ApiOperation({ summary: 'Publish/unpublish one of my certificates in the public gallery' })
  public setVisibility(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CertificateVisibilityDto,
  ): Promise<Certificate> {
    return this.certificates.setVisibility(id, user.userId, dto.is_public);
  }

  @Get(':id/pdf')
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Download one of my certificates as a PDF' })
  public async download(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
  ): Promise<StreamableFile> {
    const certificate = await this.certificates.getOwnedDownloadableCertificate(id, user.userId);
    const pdf = await this.certificates.renderPdf(certificate, resolveRequestLocale(request));
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="certificate-${certificate.certificate_number}.pdf"`,
    });
  }
}
