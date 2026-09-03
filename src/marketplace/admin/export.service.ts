import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MarketplaceOrderStatus } from '../common/enums';
import { MarketplaceOrder } from '../commerce/entities';
import { InstructorEarning } from '../earnings/entities/instructor-earning.entity';
import { LedgerService } from '../earnings/ledger.service';
import { MarketplacePayoutRequest } from '../payouts/entities';
import type { ReportingDateRange } from './reporting.service';

/** RFC-4180 field escaping, matching `PaymentOperationsService.financialReportCsv()`'s own convention. */
function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header, ...rows].map((row) => row.map(escapeCsv).join(','));
  return '﻿' + lines.join('\r\n');
}

const EXPORT_ROW_LIMIT = 10_000;

/**
 * FR-232 (T189). Row-level CSV exports — deliberately the raw underlying
 * rows for a period, not the already-on-screen summary figures every other
 * admin report already shows; an export is for taking data elsewhere.
 * Bounded at `EXPORT_ROW_LIMIT` rows per call — large enough for any single
 * reporting period at this platform's stated scale, small enough to stay a
 * synchronous HTTP response rather than needing the async
 * job-plus-download-record machinery `attendance-codes/exporters` uses for
 * genuinely unbounded exports.
 */
@Injectable()
export class MarketplaceExportService {
  constructor(
    @InjectRepository(MarketplaceOrder) private readonly orders: Repository<MarketplaceOrder>,
    @InjectRepository(InstructorEarning) private readonly earnings: Repository<InstructorEarning>,
    @InjectRepository(MarketplacePayoutRequest) private readonly payoutRequests: Repository<MarketplacePayoutRequest>,
    private readonly ledger: LedgerService,
  ) {}

  public async exportSalesCsv(currency: string, range: ReportingDateRange = {}): Promise<string> {
    const qb = this.orders
      .createQueryBuilder('o')
      .where('o.status = :status', { status: MarketplaceOrderStatus.PAID })
      .andWhere('o.currency = :currency', { currency })
      .andWhere('o.is_zero_value = false')
      .orderBy('o.paid_at', 'ASC')
      .take(EXPORT_ROW_LIMIT);
    if (range.from) qb.andWhere('o.paid_at >= :from', { from: range.from });
    if (range.to) qb.andWhere('o.paid_at <= :to', { to: range.to });
    const orders = await qb.getMany();

    return toCsv(
      ['order_number', 'course_title', 'instructor_id', 'paid_at', 'currency', 'gross_amount_minor', 'discount_amount_minor', 'net_amount_minor', 'commission_amount_minor', 'instructor_earning_minor'],
      orders.map((o) => [
        o.order_number,
        o.course_title_snapshot,
        o.instructor_id,
        o.paid_at,
        o.currency,
        o.gross_amount_minor,
        o.discount_amount_minor,
        o.net_amount_minor,
        o.commission_amount_minor,
        o.instructor_earning_minor,
      ]),
    );
  }

  public async exportEarningsCsv(currency: string, range: ReportingDateRange = {}): Promise<string> {
    const qb = this.earnings
      .createQueryBuilder('e')
      .where('e.currency = :currency', { currency })
      .orderBy('e.created_at', 'ASC')
      .take(EXPORT_ROW_LIMIT);
    if (range.from) qb.andWhere('e.created_at >= :from', { from: range.from });
    if (range.to) qb.andWhere('e.created_at <= :to', { to: range.to });
    const earnings = await qb.getMany();

    return toCsv(
      ['id', 'instructor_id', 'order_id', 'currency', 'gross_amount_minor', 'commission_amount_minor', 'net_amount_minor', 'status', 'available_at'],
      earnings.map((e) => [e.id, e.instructor_id, e.order_id, e.currency, e.gross_amount_minor, e.commission_amount_minor, e.net_amount_minor, e.status, e.available_at]),
    );
  }

  public async exportLedgerCsv(currency: string, range: ReportingDateRange = {}): Promise<string> {
    const { data } = await this.ledger.listEntriesAdmin({
      currency,
      ...(range.from !== undefined && { from: range.from }),
      ...(range.to !== undefined && { to: range.to }),
      limit: EXPORT_ROW_LIMIT,
    });

    return toCsv(
      ['id', 'instructor_id', 'order_id', 'entry_type', 'direction', 'amount_minor', 'currency', 'reference', 'created_at'],
      data.map((l) => [l.id, l.instructor_id, l.order_id, l.entry_type, l.direction, Number(l.amount_minor), l.currency, l.reference, l.created_at]),
    );
  }

  public async exportPayoutsCsv(currency: string, range: ReportingDateRange = {}): Promise<string> {
    const qb = this.payoutRequests
      .createQueryBuilder('p')
      .where('p.currency = :currency', { currency })
      .orderBy('p.requested_at', 'ASC')
      .take(EXPORT_ROW_LIMIT);
    if (range.from) qb.andWhere('p.requested_at >= :from', { from: range.from });
    if (range.to) qb.andWhere('p.requested_at <= :to', { to: range.to });
    const payouts = await qb.getMany();

    return toCsv(
      ['request_number', 'instructor_id', 'currency', 'amount_minor', 'status', 'requested_at', 'paid_at', 'payout_reference', 'reason'],
      payouts.map((p) => [p.request_number, p.instructor_id, p.currency, p.amount_minor, p.status, p.requested_at, p.paid_at, p.payout_reference, p.reason]),
    );
  }
}
