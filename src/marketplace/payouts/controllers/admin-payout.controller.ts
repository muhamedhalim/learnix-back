import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { PaginatedResponse } from '../../../common/interfaces/pagination.interface';
import { FinancePermissions } from '../../../payments/decorators/finance-permissions.decorator';
import { FinancePermissionsGuard } from '../../../payments/guards/finance-permissions.guard';
import { PayoutRequestStatus } from '../../common/enums';
import type { PayoutReport } from '../../admin/reporting.service';
import { MarketplaceReportingService } from '../../admin/reporting.service';
import { MarkPayoutFailedDto, MarkPayoutPaidDto, RejectPayoutDto } from '../dto/payout-admin.dto';
import type { MarketplacePayoutRequest } from '../entities';
import { PayoutAdminService } from '../payout-admin.service';
import { PayoutRequestService } from '../payout-request.service';

/**
 * T174 — contracts §5 payout block. FR-226: view, approve/reject and
 * processing/paid/failed are gated by three separate `marketplace.payouts.*`
 * permissions (only three exist — `.view`/`.approve`/`.pay`), so the
 * approve-vs-execute split maps onto them rather than onto a fourth
 * permission this codebase doesn't define.
 */
@ApiTags('Marketplace / Admin / Payouts')
@Controller('marketplace/admin/payouts')
@UseGuards(JwtAuthGuard, RolesGuard, FinancePermissionsGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminPayoutController {
  constructor(
    private readonly payoutRequests: PayoutRequestService,
    private readonly payoutAdmin: PayoutAdminService,
    private readonly reporting: MarketplaceReportingService,
  ) {}

  @Get()
  @FinancePermissions('marketplace.payouts.view')
  @ApiOperation({ summary: 'Payout queue, filterable by status (FR-215, FR-289)' })
  public async queue(
    @Query('status') status?: PayoutRequestStatus,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ): Promise<PaginatedResponse<MarketplacePayoutRequest>> {
    return this.payoutRequests.listQueue(status, Number(page), Number(limit));
  }

  /**
   * FR-231. Declared before `GET :id` — a route parameter with
   * `ParseUUIDPipe` would otherwise try (and fail) to parse the literal
   * path segment `report` as a UUID, since Nest matches routes in
   * declaration order.
   */
  @Get('report')
  @FinancePermissions('marketplace.reports.view')
  @ApiOperation({ summary: 'Requested / paid / rejected / reversed amounts per currency for a period (FR-231)' })
  public async report(
    @Query('currency') currency: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<PayoutReport> {
    return this.reporting.getPayoutReport(currency, {
      ...(from && { from: new Date(from) }),
      ...(to && { to: new Date(to) }),
    });
  }

  @Get(':id')
  @FinancePermissions('marketplace.payouts.view')
  @ApiOperation({ summary: 'One payout request' })
  public async get(@Param('id', ParseUUIDPipe) id: string): Promise<MarketplacePayoutRequest> {
    return this.payoutRequests.getById(id);
  }

  @Post(':id/approve')
  @FinancePermissions('marketplace.payouts.approve')
  @ApiOperation({ summary: 'Approve a requested payout (FR-216)' })
  public async approve(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketplacePayoutRequest> {
    return this.payoutAdmin.approve(user.userId, id);
  }

  @Post(':id/reject')
  @FinancePermissions('marketplace.payouts.approve')
  @ApiOperation({ summary: 'Reject a payout with a mandatory reason; returns the locked funds (FR-217)' })
  public async reject(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectPayoutDto,
  ): Promise<MarketplacePayoutRequest> {
    return this.payoutAdmin.reject(user.userId, id, dto.reason);
  }

  @Post(':id/processing')
  @FinancePermissions('marketplace.payouts.pay')
  @ApiOperation({ summary: 'Mark an approved payout as processing (FR-218)' })
  public async markProcessing(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketplacePayoutRequest> {
    return this.payoutAdmin.markProcessing(user.userId, id);
  }

  @Post(':id/paid')
  @FinancePermissions('marketplace.payouts.pay')
  @ApiOperation({ summary: 'Mark a payout paid; reference mandatory (FR-219, FR-220)' })
  public async markPaid(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkPayoutPaidDto,
  ): Promise<MarketplacePayoutRequest> {
    return this.payoutAdmin.markPaid(user.userId, id, dto.payout_reference);
  }

  @Post(':id/failed')
  @FinancePermissions('marketplace.payouts.pay')
  @ApiOperation({ summary: 'Record a payout failure — from PROCESSING (transfer never landed) or PAID (a reversal) (FR-221)' })
  public async markFailed(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkPayoutFailedDto,
  ): Promise<MarketplacePayoutRequest> {
    return this.payoutAdmin.markFailed(user.userId, id, dto.reason);
  }
}
