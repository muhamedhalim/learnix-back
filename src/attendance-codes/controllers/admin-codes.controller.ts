import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { CodeBatchesService } from '../code-batches.service';
import { BulkCodeActionDto, ListCodesQueryDto } from '../dto';
import { AttendanceCodeType } from '../entities';

@ApiTags('Admin - Codes')
@Controller('admin/codes')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminCodesController {
  constructor(private readonly codeBatchesService: CodeBatchesService) {}

  @Get()
  @ApiOperation({
    summary: 'List codes (advanced filtering)',
    description:
      'Paginated codes filtered by batch, status, type, item, creator, redeemer, date range and search.',
  })
  public async list(@Query() query: ListCodesQueryDto): Promise<unknown> {
    return await this.codeBatchesService.listCodes(query);
  }

  @Get('analytics')
  @ApiOperation({
    summary: 'Code analytics',
    description:
      'Aggregate counts: generated, redeemed, remaining, expired, revoked and redemption rate. Optionally scoped by batch/type/item.',
  })
  @ApiQuery({ name: 'batch_id', required: false })
  @ApiQuery({ name: 'type', required: false, enum: AttendanceCodeType })
  @ApiQuery({ name: 'item_id', required: false })
  public async analytics(
    @Query('batch_id') batchId?: string,
    // Typed as string (not the enum) so the Swagger param schema stays a plain
    // enum string rather than being resolved as a model reference.
    @Query('type') type?: string,
    @Query('item_id') itemId?: string,
  ): Promise<unknown> {
    const data = await this.codeBatchesService.getAnalytics({
      batch_id: batchId,
      type: type as AttendanceCodeType | undefined,
      item_id: itemId,
    });
    return { data };
  }

  @Get('analytics/dashboard')
  @ApiOperation({
    summary: 'Analytics dashboard',
    description:
      'System-wide analytics: totals, active/redeemed/expired/revoked, redemption rate, daily generation/redemption series, most-used items and most-active teachers.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    description: 'Look-back window for the daily series (default 30).',
  })
  public async dashboard(@Query('days') days?: string): Promise<unknown> {
    const window = days ? Number.parseInt(days, 10) : 30;
    const data = await this.codeBatchesService.getDashboard(
      Number.isFinite(window) && window > 0 ? window : 30,
    );
    return { data };
  }

  @Get(':id/qr')
  @Header('Content-Type', 'image/png')
  @ApiOperation({
    summary: 'Single code QR (PNG)',
    description: 'Returns a PNG QR image for the given code (preview / print).',
  })
  public async qr(@Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const png = await this.codeBatchesService.getCodeQrPng(id);
    return new StreamableFile(png, { type: 'image/png' });
  }

  @Post('bulk')
  @ApiOperation({
    summary: 'Bulk code action',
    description:
      'Apply revoke / enable / disable / delete to a selection of codes. Every affected code is written to the audit trail.',
  })
  public async bulk(@GetUser() user: JwtPayload, @Body() dto: BulkCodeActionDto): Promise<unknown> {
    const result = await this.codeBatchesService.bulkAction(dto, user.userId);
    return { data: result };
  }
}
