import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceCommissionScope } from '../common/enums';
import { MarketplaceOrder } from '../commerce/entities';
import { InstructorEarning } from '../earnings/entities/instructor-earning.entity';
import { MarketplaceLedgerEntry } from '../earnings/entities/marketplace-ledger-entry.entity';
import { MarketplacePayoutRequest } from '../payouts/entities';
import { MarketplaceRefundRequest } from '../refunds/entities';

export interface OrderMoneyTrail {
  order_id: string;
  order_number: string;
  currency: string;
  gross_amount_minor: number;
  discount_amount_minor: number;
  net_amount_minor: number;
  commission_bps: number;
  commission_scope: MarketplaceCommissionScope;
  commission_amount_minor: number;
  instructor_earning_minor: number;
  earning: {
    id: string;
    status: string;
    available_at: string;
    reversed_at: string | null;
  } | null;
  refunds: Array<{
    id: string;
    status: string;
    created_at: string;
    decided_at: string | null;
    refund_reference: string | null;
  }>;
  ledger_entries: Array<{
    id: string;
    entry_type: string;
    direction: string;
    amount_minor: number;
    created_at: string;
  }>;
  payout: {
    id: string;
    request_number: string;
    status: string;
    payout_reference: string | null;
  } | null;
}

/**
 * FR-287 (T187). One order's complete financial history, assembled from
 * every table that ever touches it — the same data every other admin
 * screen reads piecemeal, here read together for one order. Nothing here
 * is derived or recomputed: every figure is read straight off the row
 * that already owns it (the order's own snapshot fields, the earning's own
 * status, the ledger's own entries) — FR-233's "exactly reproducible... no
 * unexplained difference" holds by construction, since this is the same
 * data, not a parallel calculation of it.
 */
@Injectable()
export class MoneyTrailService {
  constructor(
    @InjectRepository(MarketplaceOrder) private readonly orders: Repository<MarketplaceOrder>,
    @InjectRepository(InstructorEarning) private readonly earnings: Repository<InstructorEarning>,
    @InjectRepository(MarketplaceRefundRequest) private readonly refunds: Repository<MarketplaceRefundRequest>,
    @InjectRepository(MarketplaceLedgerEntry) private readonly ledgerEntries: Repository<MarketplaceLedgerEntry>,
    @InjectRepository(MarketplacePayoutRequest) private readonly payoutRequests: Repository<MarketplacePayoutRequest>,
  ) {}

  public async getMoneyTrail(orderId: string): Promise<OrderMoneyTrail> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException(biBody('Order not found', 'الطلب غير موجود'));
    }

    const [earning, refunds, ledgerEntries] = await Promise.all([
      this.earnings.findOne({ where: { order_id: orderId } }),
      this.refunds.find({ where: { order_id: orderId }, order: { created_at: 'ASC' } }),
      this.ledgerEntries.find({ where: { order_id: orderId }, order: { created_at: 'ASC' } }),
    ]);

    const payout = earning?.payout_request_id
      ? await this.payoutRequests.findOne({ where: { id: earning.payout_request_id } })
      : null;

    return {
      order_id: order.id,
      order_number: order.order_number,
      currency: order.currency,
      gross_amount_minor: order.gross_amount_minor,
      discount_amount_minor: order.discount_amount_minor,
      net_amount_minor: order.net_amount_minor,
      commission_bps: order.commission_bps,
      commission_scope: order.commission_scope,
      commission_amount_minor: order.commission_amount_minor,
      instructor_earning_minor: order.instructor_earning_minor,
      earning: earning
        ? {
            id: earning.id,
            status: earning.status,
            available_at: earning.available_at.toISOString(),
            reversed_at: earning.reversed_at?.toISOString() ?? null,
          }
        : null,
      refunds: refunds.map((r) => ({
        id: r.id,
        status: r.status,
        created_at: r.created_at.toISOString(),
        decided_at: r.decided_at?.toISOString() ?? null,
        refund_reference: r.refund_reference,
      })),
      ledger_entries: ledgerEntries.map((l) => ({
        id: l.id,
        entry_type: l.entry_type,
        direction: l.direction,
        amount_minor: Number(l.amount_minor),
        created_at: l.created_at.toISOString(),
      })),
      payout: payout
        ? { id: payout.id, request_number: payout.request_number, status: payout.status, payout_reference: payout.payout_reference }
        : null,
    };
  }
}
