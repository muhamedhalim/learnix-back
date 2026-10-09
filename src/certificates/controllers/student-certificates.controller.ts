import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
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
import { Pagination20Dto } from '../../common/dto/pagination.dto';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { resolveRequestLocale } from '../../i18n/error-translator.util';
import { CertificatesService } from '../certificates.service';
import { CertificateVisibilityDto, CourseProgressBatchQueryDto } from '../dto';

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
    @Query() pagination: Pagination20Dto,
  ): Promise<unknown> {
    return await this.certificatesService.getMyCertificates(
      user.userId,
      pagination.page,
      pagination.limit,
    );
  }

  @Get('course-progress')
  @ApiOperation({
    summary: 'My completion progress for several courses at once',
    description:
      'Same figures as the single-course route, keyed by package id. A course I do not currently ' +
      'hold a valid purchase for is returned as zeros, never with lesson counts.',
  })
  public async courseProgressBatch(
    @GetUser() user: JwtPayload,
    @Query() query: CourseProgressBatchQueryDto,
  ): Promise<unknown> {
    return await this.certificatesService.getMyCourseProgressBatch(user.userId, query.package_ids);
  }

  @Get('course-progress/:packageId')
  @ApiOperation({
    summary: 'My completion progress for a course',
    description:
      "Judged against the exact curriculum version I purchased, not whatever the course's " +
      'live curriculum currently contains — so this always agrees with an issued certificate ' +
      'for the same course.',
  })
  public async courseProgress(
    @GetUser() user: JwtPayload,
    @Param('packageId', ParseUUIDPipe) packageId: string,
  ): Promise<unknown> {
    return await this.certificatesService.getMyCourseProgress(user.userId, packageId);
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
    const certificate = await this.certificatesService.getOwnedDownloadableCertificate(
      id,
      user.userId,
    );
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
