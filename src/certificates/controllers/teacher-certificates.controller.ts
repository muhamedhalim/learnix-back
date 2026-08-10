import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLE } from '../../common/constants';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { resolveRequestLocale } from '../../i18n/error-translator.util';
import { CertificatesService } from '../certificates.service';
import {
  CertificatePreviewDto,
  CertificateListFilterDto,
  CreateTemplateDto,
  IssueCertificateDto,
  RevokeCertificateDto,
  UpdateTemplateDto,
} from '../dto';

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

  /* ----- Issued certificates (own courses only) ----- */

  @Get('issued')
  @ApiOperation({ summary: "List certificates issued for the teacher's courses" })
  public list(
    @GetUser() user: JwtPayload,
    @Query() filter: CertificateListFilterDto,
  ): Promise<unknown> {
    return this.certificatesService.listCertificates(filter, user.userId);
  }

  @Get('issued/:id/pdf')
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Preview an issued certificate for one of my courses' })
  public async issuedPdf(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
  ): Promise<StreamableFile> {
    const certificate = await this.certificatesService.getManagedCertificateForTeacher(id, user.userId);
    const pdf = await this.certificatesService.renderPdf(certificate, resolveRequestLocale(request));
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="certificate-${certificate.certificate_number}.pdf"`,
    });
  }

  @Post('issue')
  @ApiOperation({ summary: 'Issue certificates for my own course' })
  public issue(@GetUser() user: JwtPayload, @Body() dto: IssueCertificateDto): Promise<unknown> {
    return this.certificatesService.bulkIssue(
      {
        packageId: dto.packageId,
        templateId: dto.templateId,
        studentIds: [...(dto.studentIds ?? []), ...(dto.studentId ? [dto.studentId] : [])],
        allCompleted: dto.allCompleted,
        force: dto.force,
      },
      user.userId,
    );
  }

  @Post('issued/:id/revoke')
  @ApiOperation({ summary: 'Revoke a certificate issued for one of my courses' })
  public revoke(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeCertificateDto,
  ): Promise<unknown> {
    return this.certificatesService.revokeCertificate(id, dto.reason, user.userId, user.userId);
  }

  @Post('issued/:id/reissue')
  @ApiOperation({ summary: 'Reissue a revoked certificate for one of my courses' })
  public reissue(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return this.certificatesService.reissueCertificate(id, user.userId, user.userId);
  }

  @Get('templates')
  @ApiOperation({ summary: 'List my certificate templates' })
  public templates(@GetUser() user: JwtPayload): Promise<unknown> {
    return this.certificatesService.getTemplates(user.userId);
  }

  @Get('templates/available')
  @ApiOperation({ summary: 'List published platform and own templates available for issuance' })
  public availableTemplates(@GetUser() user: JwtPayload): Promise<unknown> {
    return this.certificatesService.getIssuableTemplates(user.userId);
  }

  @Get('templates/:id')
  @ApiOperation({ summary: 'Get one of my certificate templates' })
  public template(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return this.certificatesService.getTemplate(id, user.userId);
  }

  @Post('templates')
  @ApiOperation({ summary: 'Create my certificate template' })
  public createTemplate(
    @GetUser() user: JwtPayload,
    @Body() dto: CreateTemplateDto,
  ): Promise<unknown> {
    return this.certificatesService.createTemplate(dto, user.userId);
  }

  @Post('templates/preview/pdf')
  @Throttle({ default: THROTTLE.DEFAULT })
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Render an unsaved template design as a sample PDF' })
  public async previewTemplate(
    @Body() dto: CertificatePreviewDto,
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

  @Post('templates/:id/publish')
  @ApiOperation({ summary: 'Publish one of my templates' })
  public publishTemplate(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return this.certificatesService.publishTemplate(id, user.userId);
  }

  @Post('templates/:id/unpublish')
  @ApiOperation({ summary: 'Return one of my templates to draft' })
  public unpublishTemplate(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return this.certificatesService.unpublishTemplate(id, user.userId);
  }

  @Post('templates/:id/archive')
  @ApiOperation({ summary: 'Archive one of my templates' })
  public archiveTemplate(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return this.certificatesService.archiveTemplate(id, user.userId);
  }

  @Post('templates/:id/duplicate')
  @ApiOperation({ summary: 'Duplicate one of my templates as a new draft' })
  public duplicateTemplate(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return this.certificatesService.duplicateTemplate(id, user.userId, user.userId);
  }

  @Patch('templates/:id')
  @ApiOperation({ summary: 'Update one of my certificate templates' })
  public updateTemplate(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ): Promise<unknown> {
    return this.certificatesService.updateTemplate(id, dto, user.userId);
  }

  @Delete('templates/:id')
  @ApiOperation({ summary: 'Delete one of my certificate templates' })
  public async deleteTemplate(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ message: string }> {
    await this.certificatesService.deleteTemplate(id, user.userId);
    return { message: 'Template deleted' };
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
