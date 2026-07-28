import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { Request } from 'express';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLE } from '../../common/constants';
import { resolveRequestLocale } from '../../i18n/error-translator.util';
import { CertificatesService } from '../certificates.service';
import {
  CertificateListFilterDto,
  CreateTemplateDto,
  IssueCertificateDto,
  RevokeCertificateDto,
  UpdateTemplateDto,
} from '../dto';

@ApiTags('Admin · Certificates')
@Controller('admin/certificates')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminCertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Get('analytics')
  @ApiOperation({ summary: 'Platform certificate analytics' })
  public analytics(): Promise<unknown> {
    return this.certificatesService.getAnalytics();
  }

  /* ----- Issued certificates ----- */

  @Get()
  @ApiOperation({ summary: 'List issued certificates (paginated, filterable)' })
  public list(@Query() filter: CertificateListFilterDto): Promise<unknown> {
    return this.certificatesService.listCertificates(filter);
  }

  @Get(':id/pdf')
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Preview an issued certificate' })
  public async pdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
  ): Promise<StreamableFile> {
    const certificate = await this.certificatesService.getManagedCertificateForTeacher(id);
    const pdf = await this.certificatesService.renderPdf(certificate, resolveRequestLocale(request));
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="certificate-${certificate.certificate_number}.pdf"`,
    });
  }

  @Post('issue')
  @ApiOperation({ summary: 'Issue certificates (single, bulk, or all-completed)' })
  public issue(@Body() dto: IssueCertificateDto): Promise<unknown> {
    return this.certificatesService.bulkIssue({
      packageId: dto.packageId,
      templateId: dto.templateId,
      studentIds: [...(dto.studentIds ?? []), ...(dto.studentId ? [dto.studentId] : [])],
      allCompleted: dto.allCompleted,
      force: dto.force,
    });
  }

  @Post(':id/revoke')
  @ApiOperation({ summary: 'Revoke an issued certificate' })
  public revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeCertificateDto,
  ): Promise<unknown> {
    return this.certificatesService.revokeCertificate(id, dto.reason);
  }

  @Post(':id/reissue')
  @ApiOperation({ summary: 'Reissue a revoked certificate under fresh credentials' })
  public reissue(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.certificatesService.reissueCertificate(id);
  }

  /* ----- Templates ----- */

  @Get('templates')
  @ApiOperation({ summary: 'List certificate templates (with issued counts)' })
  public templates(): Promise<unknown> {
    return this.certificatesService.getTemplates();
  }

  @Get('templates/:id')
  @ApiOperation({ summary: 'Get a certificate template' })
  public template(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.certificatesService.getTemplate(id);
  }

  @Post('templates')
  @ApiOperation({ summary: 'Create a certificate template (starts as a draft)' })
  public createTemplate(@Body() dto: CreateTemplateDto): Promise<unknown> {
    return this.certificatesService.createTemplate(dto);
  }

  @Post('templates/preview/pdf')
  @Throttle({ default: THROTTLE.DEFAULT })
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Render an unsaved template design as a sample PDF' })
  public async previewTemplate(
    @Body() dto: CreateTemplateDto,
    @Req() request: Request,
  ): Promise<StreamableFile> {
    const buffer = await this.certificatesService.renderTemplateSample(
      dto,
      resolveRequestLocale(request),
    );
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: 'inline; filename="template-preview.pdf"',
    });
  }

  @Patch('templates/:id')
  @ApiOperation({ summary: 'Update a certificate template' })
  public updateTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ): Promise<unknown> {
    return this.certificatesService.updateTemplate(id, dto);
  }

  @Post('templates/:id/publish')
  @ApiOperation({ summary: 'Publish a template (makes it usable for issuance)' })
  public publishTemplate(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.certificatesService.publishTemplate(id);
  }

  @Post('templates/:id/unpublish')
  @ApiOperation({ summary: 'Return a template to draft' })
  public unpublishTemplate(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.certificatesService.unpublishTemplate(id);
  }

  @Post('templates/:id/archive')
  @ApiOperation({ summary: 'Archive a template (blocks new issuance)' })
  public archiveTemplate(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.certificatesService.archiveTemplate(id);
  }

  @Post('templates/:id/duplicate')
  @ApiOperation({ summary: 'Duplicate a template as a new draft' })
  public duplicateTemplate(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.certificatesService.duplicateTemplate(id);
  }

  @Delete('templates/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a certificate template' })
  public async deleteTemplate(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ message: string }> {
    await this.certificatesService.deleteTemplate(id);
    return { message: 'Template deleted' };
  }
}
