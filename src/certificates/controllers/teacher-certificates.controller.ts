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
import { CreateTemplateDto, UpdateTemplateDto } from '../dto';

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

  @Get('templates')
  @ApiOperation({ summary: 'List my certificate templates' })
  public templates(@GetUser() user: JwtPayload): Promise<unknown> {
    return this.certificatesService.getTemplates(user.userId);
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
