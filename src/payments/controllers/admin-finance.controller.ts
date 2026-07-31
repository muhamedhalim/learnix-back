import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { FinancePermissionsGuard } from '../guards/finance-permissions.guard';
import { OrdersService } from '../services/orders.service';
import { PaymentOperationsService } from '../services/payment-operations.service';
import { RefundsService } from '../services/refunds.service';
import { SettlementsService } from '../services/settlements.service';

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
  ) {}

  @Get('orders')
  public async listOrders(@Query() filter: OrderFilterDto) {
    return this.orders.findOrders(filter);
  }

  @Post('manual-methods')
  public async createMethod(
    @Body() dto: CreateManualPaymentMethodDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.manualPayments.createMethod(dto, user.userId) };
  }

  @Get('manual-methods')
  public async listMethods() {
    return { data: await this.manualPayments.listMethods(true) };
  }

  @Patch('manual-methods/:id')
  public async updateMethod(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateManualPaymentMethodDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.manualPayments.updateMethod(id, dto, user.userId) };
  }

  @Get('manual-submissions')
  public async listSubmissions(@Query() filter: ManualSubmissionFilterDto) {
    return this.manualPayments.listReviewQueue(filter);
  }

  @Post('manual-submissions/:id/review')
  public async startReview(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: JwtPayload) {
    return { data: await this.manualPayments.startReview(id, user.userId) };
  }

  @Post('manual-submissions/:id/approve')
  public async approveSubmission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewManualPaymentDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.manualPayments.approve(id, dto, user.userId) };
  }

  @Post('manual-submissions/:id/reject')
  public async rejectSubmission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectManualPaymentDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.manualPayments.reject(id, dto, user.userId) };
  }

  @Post('manual-submissions/:id/cancel')
  public async cancelSubmission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectManualPaymentDto,
    @GetUser() user: JwtPayload,
  ) {
    return { data: await this.manualPayments.cancel(id, dto, user.userId) };
  }

  @Post('manual-submissions/:id/request-information')
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
  public async proof(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.manualPayments.getProofUrl(id) };
  }

  @Post('refunds')
  @FinancePermissions('refunds.create')
  public async requestRefund(@Body() dto: CreateRefundDto, @GetUser() user: JwtPayload) {
    return { data: await this.refunds.request(dto, user.userId) };
  }

  @Get('refunds')
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
  public async reports(@Query() filter: OrderFilterDto) {
    return { data: await this.operations.financialReport(filter) };
  }
}
