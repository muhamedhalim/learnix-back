import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CertificatesService } from '../certificates.service';
import { CreateTemplateDto, IssueCertificateDto, UpdateTemplateDto } from '../dto';

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

  @Post('issue')
  @ApiOperation({ summary: 'Manually issue a certificate (admin override)' })
  public issue(@Body() dto: IssueCertificateDto): Promise<unknown> {
    return this.certificatesService.issueForCourse(
      dto.studentId,
      dto.packageId,
      dto.force !== undefined ? { force: dto.force } : {},
    );
  }

  /* ----- Templates ----- */

  @Get('templates')
  @ApiOperation({ summary: 'List certificate templates' })
  public templates(): Promise<unknown> {
    return this.certificatesService.getTemplates();
  }

  @Get('templates/:id')
  @ApiOperation({ summary: 'Get a certificate template' })
  public template(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.certificatesService.getTemplate(id);
  }

  @Post('templates')
  @ApiOperation({ summary: 'Create a certificate template' })
  public createTemplate(@Body() dto: CreateTemplateDto): Promise<unknown> {
    return this.certificatesService.createTemplate(dto);
  }

  @Patch('templates/:id')
  @ApiOperation({ summary: 'Update a certificate template' })
  public updateTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ): Promise<unknown> {
    return this.certificatesService.updateTemplate(id, dto);
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
