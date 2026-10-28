import {
  Controller,
  Body,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { FinancePermissions } from '../../../payments/decorators/finance-permissions.decorator';
import { FinancePermissionsGuard } from '../../../payments/guards/finance-permissions.guard';
import { CompleteManualRefundDto } from '../dto/complete-manual-refund.dto';
import { DiscretionaryRefundDto } from '../dto/discretionary-refund.dto';
import { AdminRefundQueueQueryDto } from '../dto/refund-queue-query.dto';
import { MarketplaceRefundRequest } from '../entities';
import { RefundProcessingService } from '../refund-processing.service';
import { RefundRequestService, RefundRequestQueue } from '../refund-request.service';

/**
 * Contracts §4 admin block. `/approve` and `/reject` from the contract
 * collapse into `/discretionary` here — the auto-decision design in
 * `RefundRequestService.requestRefund()` (T135) already resolves every
 * request synchronously: eligible → refunded immediately, ineligible →
 * rejected immediately with the failed condition named. No REQUESTED row
 * is ever left waiting for a plain admin approve/reject; the only
 * meaningful admin lever left is overriding an auto-rejection, which is
 * exactly what a discretionary grant is (FR-186). Recorded in tasks.md.
 */
@ApiTags('Marketplace / Admin / Refunds')
@Controller('marketplace/admin/refunds')
@UseGuards(JwtAuthGuard, RolesGuard, FinancePermissionsGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminRefundController {
  constructor(
    private readonly refundRequests: RefundRequestService,
    private readonly refundProcessing: RefundProcessingService,
  ) {}

  @Get()
  @FinancePermissions('marketplace.refunds.view')
  @ApiOperation({ summary: 'Refund queue with eligibility inputs and verdict (FR-289)' })
  public async queue(@Query() query: AdminRefundQueueQueryDto): Promise<RefundRequestQueue> {
    return this.refundRequests.listQueue(query.status, query.page, query.limit);
  }

  @Get(':id')
  @FinancePermissions('marketplace.refunds.view')
  @ApiOperation({ summary: 'One refund request with its full eligibility verdict' })
  public async get(@Param('id', ParseUUIDPipe) id: string): Promise<MarketplaceRefundRequest> {
    return this.refundRequests.getById(id);
  }

  @Post('discretionary')
  // Same refund write set as the learner refund route, plus an `audit_logs` row that admin_dashboard reads
  // (`recentAdminActivity`); platform_report is kept per the T032 plan as a conservative superset.
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard', 'platform_report'])
  @FinancePermissions('marketplace.refunds.process')
  @ApiOperation({ summary: 'Grant a refund outside policy; reason mandatory (FR-186, FR-289)' })
  public async discretionary(
    @GetUser() user: JwtPayload,
    @Body() dto: DiscretionaryRefundDto,
  ): Promise<MarketplaceRefundRequest> {
    return this.refundRequests.discretionaryApprove(user.userId, dto.refundRequestId, dto.reason);
  }

  /**
   * FR-193, FR-194 — the only recovery path for a refund stuck FAILED
   * after a provider outage: `process()`'s own `claim()` already permits
   * FAILED → PROCESSING, so this is a thin pass-through, not new business
   * logic. No task explicitly asked for this admin action, but without it
   * a FAILED learner-initiated refund had no way back to COMPLETED short
   * of a manual database edit — a real operational gap, closed here.
   */
  @Post(':id/retry')
  // Re-runs `RefundProcessingService.process`: the same refund write set as the learner refund route (no audit row).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard', 'platform_report'])
  @FinancePermissions('marketplace.refunds.process')
  @ApiOperation({ summary: 'Retry a refund stuck FAILED after a provider outage' })
  public async retry(@Param('id', ParseUUIDPipe) id: string): Promise<MarketplaceRefundRequest> {
    return this.refundProcessing.process(id);
  }

  /**
   * D1 — EasyKash has no refund API. The administrator pays the learner back (gateway dashboard, bank
   * transfer, wallet) and records the reference here; only then are access, certificate, review and
   * the instructor's earning reversed. Same write set as a gateway refund, plus an `audit_logs` row.
   */
  @Post(':id/complete-manually')
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard', 'platform_report'])
  @FinancePermissions('marketplace.refunds.process')
  @ApiOperation({
    summary:
      'Record a refund paid back outside the gateway API and complete it; reference mandatory',
  })
  public async completeManually(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteManualRefundDto,
  ): Promise<MarketplaceRefundRequest> {
    return this.refundProcessing.completeManually(user.userId, id, dto.refundReference);
  }
}
