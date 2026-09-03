import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { FinancePermissions } from '../../../payments/decorators/finance-permissions.decorator';
import { FinancePermissionsGuard } from '../../../payments/guards/finance-permissions.guard';
import { MarketplaceCommissionService } from '../../earnings/commission.service';
import type { MarketplaceCommissionSetting } from '../../earnings/entities';
import { SetCommissionRateDto } from '../dto/commission-rate.dto';
import { ReportPeriodQueryDto } from '../dto/report-query.dto';
import { MarketplaceExportService } from '../export.service';
import { MoneyTrailService, OrderMoneyTrail } from '../money-trail.service';
import { ReconciliationService, DivergenceRecord } from '../../earnings/reconciliation.service';
import {
  CourseRevenueReport,
  InstructorEarningsReport,
  MarketplaceReportingService,
  RevenueSummary,
} from '../reporting.service';

/**
 * Contracts §5. FR-229/FR-230's per-instructor/per-course reports have no
 * separate route named in the contract table — folded into `/sales` via
 * optional `instructorId`/`courseId` query params, since they are the same
 * "revenue by period and currency" shape the contract's one `/sales` line
 * already covers, just narrowed. `/exports/*` — CSV downloads.
 */
@ApiTags('Marketplace / Admin / Reporting')
@Controller('marketplace/admin')
@UseGuards(JwtAuthGuard, RolesGuard, FinancePermissionsGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminReportingController {
  constructor(
    private readonly reporting: MarketplaceReportingService,
    private readonly moneyTrail: MoneyTrailService,
    private readonly reconciliation: ReconciliationService,
    private readonly commission: MarketplaceCommissionService,
    private readonly exports: MarketplaceExportService,
  ) {}

  @Get('commission')
  @FinancePermissions('marketplace.commission.manage')
  @ApiOperation({ summary: 'Current effective rate and full change history (FR-285)' })
  public async getCommission(): Promise<{ current: unknown; history: MarketplaceCommissionSetting[] }> {
    const [current, history] = await Promise.all([this.commission.resolveEffectiveRate(), this.commission.getHistory()]);
    return { current, history };
  }

  @Put('commission')
  @FinancePermissions('marketplace.commission.manage')
  @ApiOperation({ summary: 'Set a new commission rate; append-only, applies only to future orders (FR-135, FR-136)' })
  public async setCommission(
    @Body() dto: SetCommissionRateDto,
    @GetUser() admin: JwtPayload,
  ): Promise<MarketplaceCommissionSetting> {
    return this.commission.setRate({
      scope: dto.scope,
      scopeRefId: dto.scopeRefId ?? null,
      currency: dto.currency ?? null,
      rateBps: dto.rateBps,
      createdBy: admin.userId,
    });
  }

  @Get('sales')
  @FinancePermissions('marketplace.reports.view')
  @ApiOperation({ summary: 'Revenue by period and currency, platform-wide or narrowed to one instructor/course (FR-227, FR-229, FR-230)' })
  public async getSales(
    @Query() query: ReportPeriodQueryDto,
  ): Promise<RevenueSummary | InstructorEarningsReport | CourseRevenueReport> {
    const range = { ...(query.from && { from: query.from }), ...(query.to && { to: query.to }) };
    if (query.instructorId) {
      return this.reporting.getInstructorEarningsReport(query.instructorId, query.currency, range);
    }
    if (query.courseId) {
      return this.reporting.getCourseRevenueReport(query.courseId, query.currency, range);
    }
    return this.reporting.getRevenueSummary(query.currency, range);
  }

  @Get('orders/:id/money-trail')
  @FinancePermissions('marketplace.reports.view')
  @ApiOperation({ summary: "One order's complete financial history (FR-287)" })
  public async getMoneyTrail(@Param('id', ParseUUIDPipe) id: string): Promise<OrderMoneyTrail> {
    return this.moneyTrail.getMoneyTrail(id);
  }

  @Get('reconciliation')
  @FinancePermissions('marketplace.reports.view')
  @ApiOperation({ summary: 'Ledger-vs-cache divergence report (FR-234)' })
  public async getReconciliation(): Promise<DivergenceRecord[]> {
    return this.reconciliation.getDivergenceWarnings();
  }

  @Get('exports/sales')
  @FinancePermissions('marketplace.reports.export')
  @ApiOperation({ summary: 'Sales CSV export for a period (FR-232)' })
  public async exportSales(@Query() query: ReportPeriodQueryDto, @Res() response: Response): Promise<void> {
    const range = { ...(query.from && { from: query.from }), ...(query.to && { to: query.to }) };
    const csv = await this.exports.exportSalesCsv(query.currency, range);
    this.sendCsv(response, 'marketplace-sales.csv', csv);
  }

  @Get('exports/earnings')
  @FinancePermissions('marketplace.reports.export')
  @ApiOperation({ summary: 'Earnings CSV export for a period (FR-232)' })
  public async exportEarnings(@Query() query: ReportPeriodQueryDto, @Res() response: Response): Promise<void> {
    const range = { ...(query.from && { from: query.from }), ...(query.to && { to: query.to }) };
    const csv = await this.exports.exportEarningsCsv(query.currency, range);
    this.sendCsv(response, 'marketplace-earnings.csv', csv);
  }

  @Get('exports/ledger')
  @FinancePermissions('marketplace.reports.export')
  @ApiOperation({ summary: 'Ledger CSV export for a period (FR-232)' })
  public async exportLedger(@Query() query: ReportPeriodQueryDto, @Res() response: Response): Promise<void> {
    const range = { ...(query.from && { from: query.from }), ...(query.to && { to: query.to }) };
    const csv = await this.exports.exportLedgerCsv(query.currency, range);
    this.sendCsv(response, 'marketplace-ledger.csv', csv);
  }

  @Get('exports/payouts')
  @FinancePermissions('marketplace.reports.export')
  @ApiOperation({ summary: 'Payouts CSV export for a period (FR-232)' })
  public async exportPayouts(@Query() query: ReportPeriodQueryDto, @Res() response: Response): Promise<void> {
    const range = { ...(query.from && { from: query.from }), ...(query.to && { to: query.to }) };
    const csv = await this.exports.exportPayoutsCsv(query.currency, range);
    this.sendCsv(response, 'marketplace-payouts.csv', csv);
  }

  private sendCsv(response: Response, filename: string, csv: string): void {
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.send(csv);
  }
}
