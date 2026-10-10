import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import {
  CompleteRefundDto,
  CreateManualPaymentMethodDto,
  CreateRefundDto,
  CreateSettlementDto,
  FinanceAuditFilterDto,
  FinancialReportFilterDto,
  ManualSubmissionFilterDto,
  OrderFilterDto,
  PaySettlementDto,
  RefundFilterDto,
  RejectManualPaymentDto,
  ReviewManualPaymentDto,
  SettlementFilterDto,
  SettlementTerminalDto,
  UpdateManualPaymentMethodDto,
} from '../dto';
import { ManualPaymentsService } from '../services/manual-payments.service';
import { FinancePermissions } from '../decorators/finance-permissions.decorator';
import { FinanceAuditService } from '../services/finance-audit.service';
import { FinancePermissionsGuard } from '../guards/finance-permissions.guard';
import { OrdersService } from '../services/orders.service';
import { PaymentOperationsService } from '../services/payment-operations.service';
import { RefundsService } from '../services/refunds.service';
import { SettlementsService } from '../services/settlements.service';
import type { Response } from 'express';

/**
 * Every route here exposes or moves money, so each declares a finance
 * capability on top of the admin role.
 *
 * Manual-payment routes have their own capabilities (AUD-032). They previously
 * borrowed `refunds.complete` on the reasoning that approving a manual payment
 * grants access and is therefore "the same class of authority" as completing a
 * refund. Same *class* is not the same *capability*, and sharing one flag broke
 * least privilege in both directions: staff hired to vet bank transfers had to
 * be granted refund finalisation, and anyone who could finalise refunds could
 * approve payments — granting paid access — without that ever being delegated.
 *
 * Reads still take `reports.view`. Writes now split three ways:
 * `manual_payments.review` (queue work that moves no money),
 * `manual_payments.approve` (finalises the sale and grants entitlement) and
 * `manual_payments.manage_methods` (channel configuration).
 */
@ApiTags('Admin - Unified Finance')
@Controller('admin/finance')
@UseGuards(HybridAuthGuard, RolesGuard, FinancePermissionsGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminFinanceController {
  constructor(
    private readonly orders: OrdersService,
    private readonly manualPayments: ManualPaymentsService,
    private readonly refunds: RefundsService,
    private readonly settlements: SettlementsService,
    private readonly operations: PaymentOperationsService,
    private readonly financeAudit: FinanceAuditService,
  ) {}

  @Get('orders')
  @FinancePermissions('reports.view')
  public async listOrders(@Query() filter: OrderFilterDto) {
    return this.orders.findOrders(filter);
  }

  @Post('manual-methods')
  @FinancePermissions('manual_payments.manage_methods')
  public async createMethod(
    @Body() dto: CreateManualPaymentMethodDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.manualPayments.createMethod(dto, user.userId) };
  }

  @Get('manual-methods')
  @FinancePermissions('reports.view')
  public async listMethods() {
    return { data: await this.manualPayments.listMethods(true) };
  }

  @Patch('manual-methods/:id')
  @FinancePermissions('manual_payments.manage_methods')
  public async updateMethod(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateManualPaymentMethodDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.manualPayments.updateMethod(id, dto, user.userId) };
  }

  @Get('manual-submissions')
  @FinancePermissions('reports.view')
  public async listSubmissions(@Query() filter: ManualSubmissionFilterDto) {
    return this.manualPayments.listReviewQueue(filter);
  }

  /** Declared before the `:id/<action>` routes; takes no query parameters (whole-backlog counts). */
  @Get('manual-submissions/stats')
  @FinancePermissions('reports.view')
  public async submissionStats() {
    return { data: await this.manualPayments.reviewQueueStats() };
  }

  @Post('manual-submissions/:id/review')
  @FinancePermissions('manual_payments.review')
  public async startReview(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: JwtPayload) {
    return { data: await this.manualPayments.startReview(id, user.userId) };
  }

  @Post('manual-submissions/:id/approve')
  @FinancePermissions('manual_payments.approve')
  public async approveSubmission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewManualPaymentDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.manualPayments.approve(id, dto, user.userId) };
  }

  @Post('manual-submissions/:id/reject')
  @FinancePermissions('manual_payments.review')
  public async rejectSubmission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectManualPaymentDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.manualPayments.reject(id, dto, user.userId) };
  }

  @Post('manual-submissions/:id/cancel')
  @FinancePermissions('manual_payments.review')
  public async cancelSubmission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectManualPaymentDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.manualPayments.cancel(id, dto, user.userId) };
  }

  @Post('manual-submissions/:id/request-information')
  @FinancePermissions('manual_payments.review')
  public async requestInformation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectManualPaymentDto,
    @GetUser() user: JwtPayload,
  ) {
    return {
      data: await this.manualPayments.requestMoreInformation(id, dto, user.userId),
    };
  }

  @Get('manual-submissions/:id/proof')
  @FinancePermissions('reports.view')
  public async proof(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.manualPayments.getProofUrl(id) };
  }

  @Post('refunds')
  @FinancePermissions('refunds.create')
  public async requestRefund(@Body() dto: CreateRefundDto, @GetUser() user: JwtPayload) {
    return { data: await this.refunds.request(dto, user.userId) };
  }

  @Get('refunds')
  @FinancePermissions('reports.view')
  public async listRefunds(@Query() filter: RefundFilterDto) {
    return this.refunds.list(filter);
  }

  @Post('refunds/:id/process-gateway')
  @FinancePermissions('refunds.process')
  public async processGatewayRefund(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.refunds.processGateway(id, user.userId) };
  }

  @Post('refunds/:id/complete')
  @FinancePermissions('refunds.complete')
  public async completeRefund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteRefundDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.refunds.complete(id, dto, user.userId) };
  }

  @Post('settlements')
  @FinancePermissions('settlements.create')
  public async createSettlement(@Body() dto: CreateSettlementDto, @GetUser() user: JwtPayload) {
    return { data: await this.settlements.create(dto, user.userId) };
  }

  @Get('settlements')
  @FinancePermissions('settlements.view')
  public async listSettlements(@Query() filter: SettlementFilterDto) {
    return this.settlements.list(filter);
  }

  /**
   * Teacher-scoped financial audit trail.
   *
   * Read-only. Gated on `settlements.view` because it exposes the same payout
   * and refund evidence that settlement inspection already requires.
   */
  @Get('audit')
  @FinancePermissions('settlements.view')
  public async financeAuditTrail(@Query() filter: FinanceAuditFilterDto) {
    return await this.financeAudit.list(filter);
  }

  @Get('audit/actions')
  @FinancePermissions('settlements.view')
  public async financeAuditActions(@Query() filter: FinanceAuditFilterDto) {
    return { data: await this.financeAudit.actions(filter.teacher_id) };
  }

  @Get('settlements/teacher-balances')
  @FinancePermissions('settlements.view')
  public async teacherBalances(@Query() filter: SettlementFilterDto) {
    return await this.settlements.teacherBalances(filter);
  }

  @Get('settlements/:id')
  @FinancePermissions('settlements.view')
  public async settlementDetails(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.settlements.details(id) };
  }

  @Post('settlements/:id/approve')
  @FinancePermissions('settlements.approve')
  public async approveSettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.settlements.approve(id, user.userId) };
  }

  @Post('settlements/:id/pay')
  @FinancePermissions('settlements.pay')
  public async paySettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PaySettlementDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.settlements.markPaid(id, dto, user.userId) };
  }

  @Post('settlements/:id/reject')
  @FinancePermissions('settlements.reject')
  public async rejectSettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SettlementTerminalDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.settlements.reject(id, dto, user.userId) };
  }

  @Post('settlements/:id/cancel')
  @FinancePermissions('settlements.cancel')
  public async cancelSettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SettlementTerminalDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.settlements.cancel(id, dto, user.userId) };
  }

  @Get('reconciliation')
  @FinancePermissions('reconciliation.review')
  public async reconciliation() {
    return { data: await this.operations.reconciliationReport() };
  }

  @Get('reports')
  @FinancePermissions('reports.view')
  public async reports(@Query() filter: FinancialReportFilterDto) {
    return { data: await this.operations.financialReport(filter) };
  }

  @Get('reports/reconciliation-warnings')
  @FinancePermissions('reconciliation.review')
  public async reportReconciliationWarnings() {
    return { data: await this.operations.reportReconciliationWarnings() };
  }

  @Get('reports/export')
  @FinancePermissions('reports.export')
  public async exportReports(@Query() filter: FinancialReportFilterDto, @Res() response: Response) {
    const csv = await this.operations.financialReportCsv(filter);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="financial-report.csv"');
    response.send(csv);
  }
}
