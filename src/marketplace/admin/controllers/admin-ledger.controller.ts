import { Body, Controller, Get, Headers, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { PaginatedResponse } from '../../../common/interfaces/pagination.interface';
import { FinancePermissions } from '../../../payments/decorators/finance-permissions.decorator';
import { FinancePermissionsGuard } from '../../../payments/guards/finance-permissions.guard';
import { AdjustmentService } from '../../earnings/adjustment.service';
import type { MarketplaceLedgerEntry } from '../../earnings/entities/marketplace-ledger-entry.entity';
import { LedgerService } from '../../earnings/ledger.service';
import { MarketplaceLedgerEntryType } from '../../common/enums';
import { idempotencyKeyMissing } from '../../common/errors';
import { AdminLedgerQueryDto } from '../dto/report-query.dto';
import { CreateLedgerAdjustmentDto } from '../dto/ledger-adjustment.dto';

/** Contracts §5. FR-170, FR-291: viewable and filterable — this controller exposes no PATCH/PUT/DELETE for an entry, ever. */
@ApiTags('Marketplace / Admin / Ledger')
@Controller('marketplace/admin/ledger')
@UseGuards(JwtAuthGuard, RolesGuard, FinancePermissionsGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminLedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly adjustments: AdjustmentService,
  ) {}

  @Get()
  @FinancePermissions('marketplace.reports.view')
  @ApiOperation({ summary: 'Immutable ledger entries, filterable by instructor/entry type/currency/period (FR-170)' })
  public async list(@Query() query: AdminLedgerQueryDto): Promise<PaginatedResponse<MarketplaceLedgerEntry>> {
    return this.ledger.listEntriesAdmin({
      ...(query.instructorId && { instructorId: query.instructorId }),
      ...(query.entry_type && { entryType: query.entry_type as MarketplaceLedgerEntryType }),
      ...(query.currency && { currency: query.currency }),
      ...(query.from && { from: query.from }),
      ...(query.to && { to: query.to }),
      ...(query.page && { page: query.page }),
      ...(query.limit && { limit: query.limit }),
    });
  }

  @Post('adjustments')
  @FinancePermissions('marketplace.ledger.adjust')
  @ApiOperation({ summary: 'Record a manual adjustment; reason mandatory, Idempotency-Key required (FR-168, FR-173, FR-288)' })
  public async createAdjustment(
    @Body() dto: CreateLedgerAdjustmentDto,
    @GetUser() admin: JwtPayload,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MarketplaceLedgerEntry> {
    if (!idempotencyKey) {
      throw idempotencyKeyMissing();
    }
    return this.adjustments.createAdjustment({
      instructorId: dto.instructorId,
      currency: dto.currency,
      amountMinor: dto.amountMinor,
      direction: dto.direction,
      reason: dto.reason,
      adminId: admin.userId,
      idempotencyKey,
    });
  }
}
