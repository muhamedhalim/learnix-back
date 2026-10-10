
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { Body } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { CodeExportService } from '../code-export.service';
import { CodeExportFilterDto, CreateCodeExportDto } from '../dto';

@ApiTags('Admin - Code Exports')
@Controller('admin/code-exports')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminCodeExportsController {
  constructor(private readonly exportService: CodeExportService) {}

  @Post()
  @ApiOperation({
    summary: 'Create an export/print job',
    description:
      'Queues an asynchronous CSV/Excel/PDF/JSON/QR export over a filtered set of codes. Returns the PENDING job; poll GET /:id for progress, then GET /:id/download.',
  })
  @ApiResponse({ status: 201, description: 'Export queued' })
  public async create(
    @GetUser() user: JwtPayload,
    @Body() dto: CreateCodeExportDto,
  ): Promise<unknown> {
    const record = await this.exportService.createExport(dto, user.userId);
    return { data: record };
  }

  @Get()
  @ApiOperation({
    summary: 'List export jobs',
    description: 'Paginated export jobs, filterable by status, format and batch.',
  })
  public async list(@Query() filter: CodeExportFilterDto): Promise<unknown> {
    return await this.exportService.listExports(filter);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get an export job',
    description: 'Status, progress and (when completed) file metadata.',
  })
  @ApiResponse({ status: 404, description: 'Export not found' })
  public async detail(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    const data = await this.exportService.getExport(id);
    return { data };
  }

  @Get(':id/download')
  @ApiOperation({
    summary: 'Download an export file',
    description:
      'Streams the completed export file. Records a download event on the batch timeline.',
  })
  @ApiResponse({ status: 200, description: 'File stream' })
  @ApiResponse({ status: 404, description: 'File not available' })
  public async download(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const { stream, fileName, contentType, contentLength } = await this.exportService.getDownload(
      id,
      user.userId,
    );
    return new StreamableFile(stream, {
      type: contentType,
      disposition: `attachment; filename="${fileName}"`,
      ...(contentLength !== undefined ? { length: contentLength } : {}),
    });
  }
}
