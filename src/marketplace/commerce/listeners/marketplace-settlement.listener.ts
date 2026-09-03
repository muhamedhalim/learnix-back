import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';

import { retryTransaction } from '../../../common/utils/transaction-retry.util';
import { MarketplaceSettlementService } from '../settlement.service';

interface MarketplaceItemSucceededPayload {
  payment_id: string;
  order_id: string;
  verified_amount_minor: number;
  verified_currency: string;
}

interface MarketplaceItemFailedPayload {
  payment_id: string;
  order_id: string;
}

/**
 * Converts the durable payment outbox fact (`GatewayFinancialStateMachineService`'s
 * marketplace branch — `PaymentOperationsService.publishOutbox()` drains it
 * at-least-once, same mechanism `PurchaseParentNotificationListener` already
 * reacts to for the academic `payment.succeeded` event) into the actual
 * settlement write. Runs in its OWN retried transaction (FR-099's
 * `transaction-retry.util.ts` requirement) — `MarketplaceSettlementService.settle()`
 * is idempotent (`already_settled`), so an at-least-once redelivery of this
 * event is always safe.
 */
@Injectable()
export class MarketplaceSettlementListener {
  private readonly logger = new Logger(MarketplaceSettlementListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly settlement: MarketplaceSettlementService,
  ) {}

  @OnEvent('payment.marketplace_item_succeeded')
  public async handleMarketplaceItemSucceeded(payload: MarketplaceItemSucceededPayload): Promise<void> {
    if (!payload?.payment_id) return;
    try {
      const outcome = await retryTransaction(this.dataSource, (manager) =>
        this.settlement.settle(payload.payment_id, payload.verified_amount_minor, payload.verified_currency, manager),
      );
      this.logger.log(`Marketplace settlement for payment ${payload.payment_id}: ${outcome}`);
    } catch (error) {
      this.logger.error(
        `Marketplace settlement failed for payment ${payload.payment_id}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw error;
    }
  }

  /**
   * T105's "order failed" domain event. `MarketplaceSettlementService.markFailed()`
   * only ever transitions an order out of `awaiting_payment` — an order already
   * settled by a `succeeded` webhook that arrives before this one (out-of-order
   * redelivery, the same guarantee `settle()`'s own idempotency gives the
   * success path) is left untouched.
   */
  @OnEvent('payment.marketplace_item_failed')
  public async handleMarketplaceItemFailed(payload: MarketplaceItemFailedPayload): Promise<void> {
    if (!payload?.payment_id) return;
    try {
      const outcome = await retryTransaction(this.dataSource, (manager) =>
        this.settlement.markFailed(payload.payment_id, manager),
      );
      this.logger.log(`Marketplace order-failed handling for payment ${payload.payment_id}: ${outcome}`);
    } catch (error) {
      this.logger.error(
        `Marketplace order-failed handling failed for payment ${payload.payment_id}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw error;
    }
  }
}
