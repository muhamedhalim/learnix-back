import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { THROTTLE } from '../../../common/constants';
import { PaginatedResponse } from '../../../common/interfaces/pagination.interface';
import { ApprovedInstructor } from '../../common/decorators/approved-instructor.decorator';
import { CurrentInstructor } from '../../common/decorators/current-instructor.decorator';
import { MarketplaceListQueryDto } from '../../common/dto/marketplace-pagination.dto';
import { idempotencyKeyMissing } from '../../common/errors';
import { PayoutRequestThrottlerGuard } from '../../common/guards/per-account-throttler.guard';
import type { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';
import { CreatePayoutAccountDto, UpdatePayoutAccountDto } from '../dto/payout-account.dto';
import { CreatePayoutRequestDto } from '../dto/payout-request.dto';
import type { MarketplacePayoutRequest } from '../entities';
import { PayoutAccountService, PayoutAccountSummary } from '../payout-account.service';
import { PayoutRequestService } from '../payout-request.service';

/**
 * T173 — contracts §3 payout block, accounts and requests both. One
 * controller for the whole instructor-facing payout surface, matching the
 * task's own file grouping; ownership is always resolved via
 * `@CurrentInstructor()` (`MarketplaceInstructor.id`), never a route param.
 */
@ApiTags('Marketplace / Instructor Payouts')
@Controller('marketplace/instructor')
@ApprovedInstructor()
@ApiBearerAuth('JWT-auth')
export class InstructorPayoutController {
  constructor(
    private readonly accounts: PayoutAccountService,
    private readonly requests: PayoutRequestService,
  ) {}

  @Get('payout-accounts')
  @ApiOperation({ summary: 'Own payout accounts (FR-200)' })
  public async listAccounts(@CurrentInstructor() instructor: MarketplaceInstructor): Promise<PayoutAccountSummary[]> {
    return this.accounts.list(instructor.id);
  }

  @Post('payout-accounts')
  @ApiOperation({ summary: 'Add a payout account; identifier encrypted before storage (FR-200)' })
  public async createAccount(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Body() dto: CreatePayoutAccountDto,
  ): Promise<PayoutAccountSummary> {
    return this.accounts.create(instructor.id, {
      accountHolderName: dto.account_holder_name,
      bankName: dto.bank_name,
      accountIdentifier: dto.account_identifier,
      currency: dto.currency,
      country: dto.country,
    });
  }

  @Patch('payout-accounts/:id')
  @ApiOperation({ summary: 'Edit a payout account; a changed identifier re-queues verification (FR-201)' })
  public async updateAccount(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePayoutAccountDto,
  ): Promise<PayoutAccountSummary> {
    return this.accounts.update(instructor.id, id, {
      ...(dto.account_holder_name !== undefined && { accountHolderName: dto.account_holder_name }),
      ...(dto.bank_name !== undefined && { bankName: dto.bank_name }),
      ...(dto.account_identifier !== undefined && { accountIdentifier: dto.account_identifier }),
    });
  }

  @Post('payout-accounts/:id/default')
  @ApiOperation({ summary: 'Make this account the default for its currency (FR-202)' })
  public async setDefaultAccount(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PayoutAccountSummary> {
    return this.accounts.setDefault(instructor.id, id);
  }

  @Delete('payout-accounts/:id')
  @ApiOperation({ summary: 'Remove a payout account; refused while referenced by an in-flight payout (FR-204)' })
  public async removeAccount(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ success: true }> {
    await this.accounts.remove(instructor.id, id);
    return { success: true };
  }

  @Get('payouts')
  @ApiOperation({ summary: 'Own payout request history (FR-215)' })
  public async listRequests(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Query() query: MarketplaceListQueryDto,
  ): Promise<PaginatedResponse<MarketplacePayoutRequest>> {
    return this.requests.listOwn(instructor.id, query.page, query.limit);
  }

  @Get('payouts/:id')
  @ApiOperation({ summary: 'One own payout request' })
  public async getRequest(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketplacePayoutRequest> {
    return this.requests.getOwn(instructor.id, id);
  }

  @Post('payouts')
  @UseGuards(PayoutRequestThrottlerGuard)
  @Throttle({ default: THROTTLE.STRICT })
  @ApiOperation({ summary: 'Request a payout; Idempotency-Key required (FR-206, FR-209)' })
  public async createRequest(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Body() dto: CreatePayoutRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MarketplacePayoutRequest> {
    if (!idempotencyKey) {
      throw idempotencyKeyMissing();
    }
    return this.requests.createRequest(
      instructor.id,
      { payoutAccountId: dto.payout_account_id, amountMinor: dto.amount_minor, currency: dto.currency },
      idempotencyKey,
    );
  }

  @Post('payouts/:id/cancel')
  @ApiOperation({ summary: 'Cancel an own payout request while still REQUESTED (FR-214)' })
  public async cancelRequest(
    @CurrentInstructor() instructor: MarketplaceInstructor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketplacePayoutRequest> {
    return this.requests.cancel(instructor.id, id);
  }
}
