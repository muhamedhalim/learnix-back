import { createHash, randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import {
  acquireTeacherFinancialLock,
  retryTransaction,
} from '../../common/utils/transaction-retry.util';
import { biBody } from '../../i18n/error-translator.util';
import { AdminNotificationEvent } from '../../notifications/constants/admin-notification-events';
import { Notification } from '../../notifications/entities/notification.entity';
import { NotificationOrigin } from '../../notifications/entities/notification-origin.enum';
import { NotificationStatus } from '../../notifications/entities/notification-status.enum';
import { NotificationType } from '../../notifications/entities/notification-type.enum';
import { AdminNotificationsService } from '../../notifications/services/admin-notifications.service';
import {
  CreateSettlementDto,
  PaySettlementDto,
  SettlementFilterDto,
  SettlementTerminalDto,
} from '../dto';
import {
  CollectionParty,
  FinancialLedgerEntry,
  LedgerDirection,
  LedgerEntryStatus,
  LedgerEntryType,
  Order,
  OrderStatus,
  PaymentAuditLog,
  PaymentChannel,
  Settlement,
  SettlementEntry,
  SettlementStatus,
} from '../entities';
import { fromMinorUnits } from '../money.util';
import { writeDomainEvent, writePaymentAudit } from '../finance-persistence';

interface SumRow {
  value: string | null;
}

const RESERVING_SETTLEMENT_STATUSES = [
  SettlementStatus.DRAFT,
  SettlementStatus.APPROVED,
  SettlementStatus.PAID,
] as const;

/**
 * Teacher-safe wallet projection.  This deliberately contains only balances
 * and events attributable to the authenticated teacher; platform collection
 * totals are an admin-finance concern and must never leave the teacher API.
 */
export interface TeacherWalletSummary {
  /** Legacy flat values are present only where exactly one currency exists. */
  currency: string | null;
  pending_balance_minor: number | null;
  available_balance_minor: number | null;
  lifetime_earnings_minor: number | null;
  paid_out_minor: number | null;
  refunded_reversed_minor: number | null;
  teacher_collected_sales_minor: number | null;
  outstanding_platform_receivable_minor: number | null;
  next_settlement_date: null;
  balances: TeacherWalletCurrencySummary[];
}

export interface TeacherWalletCurrencySummary {
  currency: string;
  pending_balance_minor: number;
  available_balance_minor: number;
  lifetime_earnings_minor: number;
  paid_out_minor: number;
  refunded_reversed_minor: number;
  teacher_collected_sales_minor: number;
  outstanding_platform_receivable_minor: number;
}

/** How long an available balance may sit unsettled before admins are alerted. */
const OVERDUE_PAYOUT_THRESHOLD_DAYS = 14;
/** The full-table aggregate below is cheap but pointless to re-run every minute. */
const OVERDUE_PAYOUT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class SettlementsService {
  private readonly minimumPayoutMinor: number;
  private lastOverduePayoutCheckAt = 0;

  constructor(
    @InjectRepository(Settlement)
    private readonly settlements: Repository<Settlement>,
    @InjectRepository(FinancialLedgerEntry)
    private readonly ledger: Repository<FinancialLedgerEntry>,
    private readonly dataSource: DataSource,
    private readonly adminNotifications: AdminNotificationsService,
    config: ConfigService,
  ) {
    this.minimumPayoutMinor = Math.max(
      0,
      Number.parseInt(config.get<string>('MINIMUM_SETTLEMENT_MINOR') ?? '10000', 10),
    );
  }

  public async getTeacherWallet(teacherId: string): Promise<TeacherWalletSummary> {
    const rows = await this.ledger.query<
      Array<{
        currency: string;
        pending_balance_minor: string;
        available_balance_minor: string;
        lifetime_earnings_minor: string;
        paid_out_minor: string;
        refunded_reversed_minor: string;
        teacher_collected_sales_minor: string;
        outstanding_platform_receivable_minor: string;
      }>
    >(
      `
      SELECT currency,
        COALESCE(SUM(CASE WHEN account = 'teacher_payable' THEN CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END ELSE 0 END), 0)::text AS pending_balance_minor,
        COALESCE(SUM(CASE WHEN account = 'teacher_payable_available' THEN CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END ELSE 0 END), 0)::text AS available_balance_minor,
        COALESCE(SUM(CASE WHEN entry_type = 'payout' THEN CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END ELSE 0 END), 0)::text AS paid_out_minor,
        COALESCE(SUM(CASE WHEN entry_type = 'teacher_earning_reversal' THEN CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END ELSE 0 END), 0)::text AS refunded_reversed_minor,
        COALESCE(SUM(CASE WHEN entry_type = 'teacher_collected_sale' THEN CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END ELSE 0 END), 0)::text AS teacher_collected_sales_minor,
        COALESCE(SUM(CASE WHEN account = 'platform_receivable' THEN CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END ELSE 0 END), 0)::text AS outstanding_platform_receivable_minor,
        COALESCE(SUM(CASE WHEN direction = 'credit' AND (entry_type = 'teacher_earning_pending' OR (entry_type = 'teacher_earning_available' AND reference LIKE 'order:%')) THEN amount_minor ELSE 0 END), 0)::text AS lifetime_earnings_minor
      FROM financial_ledger_entries WHERE teacher_id = $1 GROUP BY currency ORDER BY currency ASC
    `,
      [teacherId],
    );
    const balances = rows.map((row) => ({
      currency: String(row.currency),
      pending_balance_minor: Number(row.pending_balance_minor ?? 0),
      available_balance_minor: Number(row.available_balance_minor ?? 0),
      lifetime_earnings_minor: Number(row.lifetime_earnings_minor ?? 0),
      paid_out_minor: Math.abs(Number(row.paid_out_minor ?? 0)),
      refunded_reversed_minor: Math.abs(Number(row.refunded_reversed_minor ?? 0)),
      teacher_collected_sales_minor: Number(row.teacher_collected_sales_minor ?? 0),
      outstanding_platform_receivable_minor: Number(row.outstanding_platform_receivable_minor ?? 0),
    }));
    const legacy = balances.length === 1 ? balances[0] : null;
    return {
      currency: legacy?.currency ?? null,
      pending_balance_minor: legacy?.pending_balance_minor ?? null,
      available_balance_minor: legacy?.available_balance_minor ?? null,
      lifetime_earnings_minor: legacy?.lifetime_earnings_minor ?? null,
      paid_out_minor: legacy?.paid_out_minor ?? null,
      refunded_reversed_minor: legacy?.refunded_reversed_minor ?? null,
      teacher_collected_sales_minor: legacy?.teacher_collected_sales_minor ?? null,
      outstanding_platform_receivable_minor: legacy?.outstanding_platform_receivable_minor ?? null,
      next_settlement_date: null,
      balances,
    };
  }

  public async create(dto: CreateSettlementDto, adminId: string): Promise<Settlement> {
    const idempotencyFingerprint = this.createFingerprint(dto);
    const idempotencyKey = this.normalizedIdempotencyKey(
      dto.idempotency_key,
      idempotencyFingerprint,
    );
    try {
      return await retryTransaction(
        this.dataSource,
        async (manager) => {
          const existing = await manager.findOne(Settlement, {
            where: { idempotency_key: idempotencyKey },
          });
          if (existing) {
            if (existing.idempotency_fingerprint !== idempotencyFingerprint) {
              throw new ConflictException(
                biBody(
                  'Idempotency key was already used with a different settlement request',
                  'تم استخدام مفتاح منع التكرار مسبقاً مع طلب تسوية مختلف',
                ),
              );
            }
            return existing;
          }
          await acquireTeacherFinancialLock(manager, dto.teacher_id);
          // Lock the complete available-payable account before selecting earnings.
          // Refund reversals are debit entries in this same account, so settlement
          // eligibility is always capped by the net outstanding liability.
          const query = manager
            .getRepository(FinancialLedgerEntry)
            .createQueryBuilder('entry')
            .where('entry.teacher_id = :teacherId', { teacherId: dto.teacher_id })
            .andWhere('entry.account = :account', { account: 'teacher_payable_available' })
            .andWhere('entry.entry_type = :entryType', {
              entryType: LedgerEntryType.TEACHER_EARNING_AVAILABLE,
            })
            .andWhere('entry.direction = :direction', { direction: LedgerDirection.CREDIT })
            .andWhere(
              `NOT EXISTS (
            SELECT 1 FROM financial_ledger_entries reversal
            WHERE reversal.order_id = entry.order_id
              AND reversal.entry_type = :earningReversal
          )`,
              { earningReversal: LedgerEntryType.TEACHER_EARNING_REVERSAL },
            )
            .andWhere(
              `entry.amount_minor > COALESCE((
              SELECT SUM(membership.amount_minor)
              FROM teacher_settlement_entries membership
              INNER JOIN teacher_settlements reserved_settlement
                ON reserved_settlement.id = membership.settlement_id
              WHERE membership.ledger_entry_id = entry.id
                AND reserved_settlement.status IN (:...reservingStatuses)
            ), 0)`,
              { reservingStatuses: RESERVING_SETTLEMENT_STATUSES },
            );
          if (dto.currency) {
            query.andWhere('entry.currency = :currency', { currency: dto.currency.toUpperCase() });
          }
          if (dto.ledger_entry_ids?.length) {
            query.andWhere('entry.id IN (:...entryIds)', { entryIds: dto.ledger_entry_ids });
          }
          let entries = await query.orderBy('entry.created_at', 'ASC').getMany();
          if (entries.length === 0) {
            throw new ConflictException(
              biBody(
                'No available earnings are eligible for settlement',
                'لا توجد أرباح متاحة مؤهلة للتسوية',
              ),
            );
          }
          if (
            dto.ledger_entry_ids?.length &&
            entries.length !== new Set(dto.ledger_entry_ids).size
          ) {
            throw new ConflictException(
              biBody(
                'One or more ledger entries are unavailable or already settled',
                'قيد أو أكثر غير متاح أو تمت تسويته',
              ),
            );
          }
          // The advisory lock is acquired first. Lock all affected orders before
          // locking ledger rows, so this follows the shared financial lock order.
          for (const orderId of [...new Set(entries.map((entry) => entry.order_id))].sort()) {
            await manager.findOne(Order, {
              where: { id: orderId },
              lock: { mode: 'pessimistic_write' },
            });
          }
          entries = await query.setLock('pessimistic_write').getMany();
          const payableEntries = await manager
            .getRepository(FinancialLedgerEntry)
            .createQueryBuilder('payable')
            .setLock('pessimistic_write')
            .where('payable.teacher_id = :teacherId', { teacherId: dto.teacher_id })
            .andWhere('payable.account = :account', { account: 'teacher_payable_available' })
            .orderBy('payable.id', 'ASC')
            .getMany();
          const currency = entries[0]?.currency ?? 'EGP';
          if (entries.some((entry) => entry.currency !== currency)) {
            throw new BadRequestException(
              biBody(
                'Settlement entries must use one currency',
                'يجب أن تستخدم قيود التسوية عملة واحدة',
              ),
            );
          }
          const netAvailable = payableEntries
            .filter((entry) => entry.currency === currency)
            .reduce(
              (sum, entry) =>
                sum +
                (entry.direction === LedgerDirection.CREDIT
                  ? entry.amount_minor
                  : -entry.amount_minor),
              0,
            );
          if (netAvailable <= 0) {
            throw new ConflictException(
              biBody(
                'Teacher has no positive net payable balance',
                'Teacher has no positive net payable balance',
              ),
            );
          }
          const existingAllocations = await manager
            .getRepository(SettlementEntry)
            .createQueryBuilder('membership')
            .innerJoin(
              Settlement,
              'reserved_settlement',
              'reserved_settlement.id = membership.settlement_id',
            )
            .select('membership.ledger_entry_id', 'ledger_entry_id')
            .addSelect('COALESCE(SUM(membership.amount_minor), 0)', 'allocated_minor')
            .where('membership.ledger_entry_id IN (:...entryIds)', {
              entryIds: entries.map((entry) => entry.id),
            })
            .andWhere('reserved_settlement.status IN (:...reservingStatuses)', {
              reservingStatuses: RESERVING_SETTLEMENT_STATUSES,
            })
            .groupBy('membership.ledger_entry_id')
            .getRawMany<{ ledger_entry_id: string; allocated_minor: string }>();
          const allocatedByEntry = new Map(
            existingAllocations.map((row) => [row.ledger_entry_id, Number(row.allocated_minor)]),
          );
          const requestedGross = dto.amount_minor ?? netAvailable;
          if (requestedGross > netAvailable) {
            throw new ConflictException(
              biBody(
                'Settlement exceeds the teacher available balance',
                'قيمة التسوية تتجاوز الرصيد المتاح للمعلم',
              ),
            );
          }
          let remainingNet = requestedGross;
          const allocations: Array<{ entry: FinancialLedgerEntry; amountMinor: number }> = [];
          for (const entry of entries) {
            if (remainingNet <= 0) break;
            const availableForEntry = entry.amount_minor - (allocatedByEntry.get(entry.id) ?? 0);
            const amountMinor = Math.min(availableForEntry, remainingNet);
            if (amountMinor <= 0) continue;
            allocations.push({ entry, amountMinor });
            remainingNet -= amountMinor;
          }
          const gross = allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
          if (gross <= 0 || gross !== requestedGross || gross > netAvailable) {
            throw new ConflictException(
              biBody(
                'Settlement exceeds the teacher net payable balance',
                'Settlement exceeds the teacher net payable balance',
              ),
            );
          }
          const deductions = dto.deductions_minor ?? 0;
          const receivableOffset = dto.receivable_offset_minor ?? 0;
          const outstandingReceivable = await this.accountBalanceWithManager(
            manager,
            dto.teacher_id,
            'platform_receivable',
            currency,
          );
          if (receivableOffset > outstandingReceivable) {
            throw new BadRequestException(
              biBody(
                'Receivable offset exceeds outstanding receivable',
                'مقاصة المديونية تتجاوز الرصيد المستحق',
              ),
            );
          }
          const payout = gross - deductions - receivableOffset;
          if (payout < this.minimumPayoutMinor) {
            throw new BadRequestException(
              biBody(
                `Settlement payout must be at least ${String(this.minimumPayoutMinor)} minor units`,
                'قيمة التسوية أقل من الحد الأدنى للصرف',
              ),
            );
          }
          const settlement = await manager.save(
            Settlement,
            manager.create(Settlement, {
              settlement_number: this.generateNumber(),
              idempotency_key: idempotencyKey,
              idempotency_fingerprint: idempotencyFingerprint,
              teacher_id: dto.teacher_id,
              gross_amount_minor: gross,
              deductions_minor: deductions,
              receivable_offset_minor: receivableOffset,
              payout_amount_minor: payout,
              currency,
              fiscal_period: this.fiscalPeriod(dto.fiscal_period),
              status: SettlementStatus.DRAFT,
              payment_method: dto.payment_method,
              transfer_reference: null,
              execution_idempotency_key: null,
              execution_fingerprint: null,
              proof_file_key: null,
              notes: dto.notes?.trim() ?? null,
              initiated_by: adminId,
              approved_by: null,
              paid_by: null,
              paid_at: null,
            }),
          );
          await manager.insert(
            SettlementEntry,
            allocations.map(({ entry, amountMinor }) => ({
              settlement_id: settlement.id,
              ledger_entry_id: entry.id,
              amount_minor: amountMinor,
            })),
          );
          await this.audit(manager, adminId, 'settlement_created', settlement, {
            ledger_entry_ids: allocations.map(({ entry }) => entry.id),
            allocated_amounts_minor: allocations.map(({ entry, amountMinor }) => ({
              ledger_entry_id: entry.id,
              amount_minor: amountMinor,
            })),
          });
          await writeDomainEvent(
            manager,
            'settlement.created',
            `settlement:${settlement.id}:created`,
            {
              settlement_id: settlement.id,
              teacher_id: settlement.teacher_id,
              payout_amount_minor: settlement.payout_amount_minor,
            },
          );
          return settlement;
        },
        { isolationLevel: 'SERIALIZABLE' },
      );
    } catch (error) {
      // A concurrent retry can reach the unique index after its initial lookup.
      // Resolve only the exact same logical request; never silently accept key reuse.
      const existing = await this.settlements.findOne({
        where: { idempotency_key: idempotencyKey },
      });
      if (existing) {
        if (existing.idempotency_fingerprint === idempotencyFingerprint) return existing;
        throw new ConflictException(
          biBody(
            'Idempotency key was already used with a different settlement request',
            'تم استخدام مفتاح منع التكرار مسبقاً مع طلب تسوية مختلف',
          ),
        );
      }
      this.rethrowFinancialConstraint(error);
    }
  }

  public async approve(settlementId: string, adminId: string): Promise<Settlement> {
    return retryTransaction(this.dataSource, async (manager) => {
      const settlement = await this.lock(manager, settlementId);
      if (settlement.status !== SettlementStatus.DRAFT) {
        throw new ConflictException(
          biBody('Only a draft settlement can be approved', 'يمكن اعتماد التسوية المسودة فقط'),
        );
      }
      if (settlement.initiated_by === adminId) {
        throw new ConflictException(
          biBody(
            'Settlement creator cannot approve the same settlement',
            'Settlement creator cannot approve the same settlement',
          ),
        );
      }
      settlement.status = SettlementStatus.APPROVED;
      settlement.approved_by = adminId;
      await manager.save(Settlement, settlement);
      await this.audit(manager, adminId, 'settlement_approved', settlement, {});
      return settlement;
    });
  }

  public async markPaid(
    settlementId: string,
    dto: PaySettlementDto,
    adminId: string,
  ): Promise<Settlement> {
    const candidate = await this.settlements.findOne({ where: { id: settlementId } });
    if (!candidate) {
      throw new NotFoundException(biBody('Settlement not found', 'Settlement not found'));
    }
    try {
      return await retryTransaction(
        this.dataSource,
        async (manager) => {
          await acquireTeacherFinancialLock(manager, candidate.teacher_id);
          const settlement = await this.lock(manager, settlementId);
          const transferReference = dto.transfer_reference.trim();
          if (!transferReference) {
            throw new BadRequestException(
              biBody('Transfer reference is required', 'مرجع التحويل مطلوب'),
            );
          }
          const transferMethod = dto.transfer_method?.trim() || settlement.payment_method.trim();
          if (!transferMethod) {
            throw new BadRequestException(
              biBody('Transfer method is required', 'Transfer method is required'),
            );
          }
          const transferDate = dto.transfer_date ? new Date(dto.transfer_date) : new Date();
          if (Number.isNaN(transferDate.getTime())) {
            throw new BadRequestException(
              biBody('Transfer date is invalid', 'Transfer date is invalid'),
            );
          }
          const executionFingerprint = this.executionFingerprint(
            settlement,
            transferReference,
            dto,
            transferMethod,
          );
          const executionKey = this.normalizedExecutionKey(
            dto.idempotency_key,
            executionFingerprint,
          );
          const keyOwner = await manager.findOne(Settlement, {
            where: { execution_idempotency_key: executionKey },
            lock: { mode: 'pessimistic_read' },
          });
          if (keyOwner && keyOwner.id !== settlement.id) {
            throw new ConflictException(
              biBody(
                'Execution idempotency key belongs to a different settlement',
                'Execution idempotency key belongs to a different settlement',
              ),
            );
          }
          if (settlement.status === SettlementStatus.PAID) {
            if (settlement.execution_fingerprint === executionFingerprint) {
              return settlement;
            }
            // Historical executions predate the fingerprint. Preserve their API
            // replay behaviour only when every mutable request property matches.
            if (
              !dto.idempotency_key &&
              settlement.execution_idempotency_key?.startsWith('legacy-execution:') &&
              settlement.transfer_reference &&
              this.normalizedTransferReference(settlement.transfer_reference) ===
                this.normalizedTransferReference(transferReference) &&
              (settlement.notes?.trim() ?? '') === (dto.notes?.trim() ?? '')
            )
              return settlement;
            throw new ConflictException(
              biBody(
                'A paid settlement cannot be overwritten with a different transfer reference',
                'لا يمكن استبدال مرجع تحويل لتسوية مدفوعة',
              ),
            );
          }
          if (settlement.status !== SettlementStatus.APPROVED) {
            throw new ConflictException(
              biBody('Settlement must be approved before payment', 'يجب اعتماد التسوية قبل الدفع'),
            );
          }
          if (settlement.initiated_by === adminId || settlement.approved_by === adminId) {
            throw new ConflictException(
              biBody(
                'Settlement creator or approver cannot disburse the same settlement',
                'Settlement creator or approver cannot disburse the same settlement',
              ),
            );
          }
          const memberOrders = await manager
            .getRepository(SettlementEntry)
            .createQueryBuilder('membership')
            .innerJoin(FinancialLedgerEntry, 'earning', 'earning.id = membership.ledger_entry_id')
            .select('DISTINCT earning.order_id', 'order_id')
            .where('membership.settlement_id = :settlementId', {
              settlementId: settlement.id,
            })
            .getRawMany<{ order_id: string }>();
          for (const orderId of memberOrders.map((row) => row.order_id).sort()) {
            await manager.findOne(Order, {
              where: { id: orderId },
              lock: { mode: 'pessimistic_write' },
            });
          }
          const reversedMembers = await manager
            .getRepository(SettlementEntry)
            .createQueryBuilder('membership')
            .innerJoin(FinancialLedgerEntry, 'earning', 'earning.id = membership.ledger_entry_id')
            .innerJoin(
              FinancialLedgerEntry,
              'reversal',
              'reversal.order_id = earning.order_id AND reversal.entry_type = :reversalType',
              { reversalType: LedgerEntryType.TEACHER_EARNING_REVERSAL },
            )
            .where('membership.settlement_id = :settlementId', {
              settlementId: settlement.id,
            })
            .getCount();
          if (reversedMembers > 0) {
            throw new ConflictException(
              biBody(
                'Settlement includes earnings reversed by a refund and must be recreated',
                'تتضمن التسوية أرباحاً تم عكسها بسبب استرداد ويجب إعادة إنشائها',
              ),
            );
          }
          const payableEntries = await manager
            .getRepository(FinancialLedgerEntry)
            .createQueryBuilder('entry')
            .setLock('pessimistic_write')
            .where('entry.teacher_id = :teacherId', { teacherId: settlement.teacher_id })
            .andWhere('entry.account = :account', { account: 'teacher_payable_available' })
            .andWhere('entry.currency = :currency', { currency: settlement.currency })
            .getMany();
          const netAvailable = payableEntries.reduce(
            (sum, entry) =>
              sum +
              (entry.direction === LedgerDirection.CREDIT
                ? entry.amount_minor
                : -entry.amount_minor),
            0,
          );
          if (netAvailable < settlement.gross_amount_minor) {
            throw new ConflictException(
              biBody(
                'Settlement is no longer covered by the teacher net payable balance',
                'Settlement is no longer covered by the teacher net payable balance',
              ),
            );
          }
          const duplicateReference = await manager
            .getRepository(Settlement)
            .createQueryBuilder('paid_settlement')
            .setLock('pessimistic_read')
            .where('paid_settlement.status = :status', { status: SettlementStatus.PAID })
            .andWhere(
              'LOWER(BTRIM(paid_settlement.transfer_reference)) = LOWER(BTRIM(:reference))',
              {
                reference: transferReference,
              },
            )
            .andWhere('paid_settlement.id != :id', { id: settlement.id })
            .getOne();
          if (duplicateReference) {
            throw new ConflictException(
              biBody('Transfer reference has already been used', 'تم استخدام مرجع التحويل مسبقاً'),
            );
          }
          settlement.status = SettlementStatus.PAID;
          settlement.transfer_reference = transferReference;
          settlement.payment_method = transferMethod;
          settlement.execution_idempotency_key = executionKey;
          settlement.execution_fingerprint = executionFingerprint;
          settlement.paid_by = adminId;
          settlement.paid_at = transferDate;
          if (dto.notes?.trim()) settlement.notes = dto.notes.trim();
          await manager.save(Settlement, settlement);
          const syntheticOrderId = await this.firstOrderId(manager, settlement.id);
          if (!syntheticOrderId) {
            throw new ConflictException(
              biBody('Settlement has no ledger members', 'التسوية لا تحتوي على قيود مالية'),
            );
          }
          const common = {
            order_id: syntheticOrderId,
            payment_id: null,
            teacher_id: settlement.teacher_id,
            currency: settlement.currency,
            status: LedgerEntryStatus.SETTLED,
            available_at: settlement.paid_at,
            source_channel: PaymentChannel.LEGACY,
            collection_party: CollectionParty.PLATFORM,
            settlement_id: settlement.id,
            metadata: { transfer_reference: settlement.transfer_reference },
          };
          const settlementEntries: Array<Partial<FinancialLedgerEntry>> = [
            {
              ...common,
              account: 'teacher_payable_available',
              entry_type: LedgerEntryType.SETTLEMENT_LIABILITY_CLEARING,
              amount_minor: settlement.gross_amount_minor,
              direction: LedgerDirection.DEBIT,
              reference: `settlement:${settlement.id}:liability`,
            },
            {
              ...common,
              account: 'platform_cash',
              entry_type: LedgerEntryType.PAYOUT,
              amount_minor: settlement.payout_amount_minor,
              direction: LedgerDirection.CREDIT,
              reference: `settlement:${settlement.id}:payout`,
            },
          ];
          if (settlement.deductions_minor > 0) {
            settlementEntries.push({
              ...common,
              account: 'platform_revenue',
              entry_type: LedgerEntryType.SETTLEMENT_DEDUCTION,
              amount_minor: settlement.deductions_minor,
              direction: LedgerDirection.CREDIT,
              reference: `settlement:${settlement.id}:deduction`,
            });
          }
          if (settlement.receivable_offset_minor > 0) {
            settlementEntries.push(
              {
                ...common,
                account: 'settlement_offset_clearing',
                entry_type: LedgerEntryType.SETTLEMENT_OFFSET_CLEARING,
                amount_minor: settlement.receivable_offset_minor,
                direction: LedgerDirection.CREDIT,
                reference: `settlement:${settlement.id}:offset-destination`,
              },
              {
                ...common,
                account: 'platform_receivable',
                entry_type: LedgerEntryType.RECEIVABLE_SETTLEMENT,
                amount_minor: settlement.receivable_offset_minor,
                direction: LedgerDirection.DEBIT,
                reference: `settlement:${settlement.id}:receivable-offset`,
              },
              {
                ...common,
                account: 'settlement_offset_clearing',
                entry_type: LedgerEntryType.SETTLEMENT_OFFSET_CLEARING,
                amount_minor: settlement.receivable_offset_minor,
                direction: LedgerDirection.CREDIT,
                reference: `settlement:${settlement.id}:receivable-clearing`,
              },
            );
          }
          await manager.insert(FinancialLedgerEntry, settlementEntries as never);
          await this.audit(manager, adminId, 'settlement_paid', settlement, {
            transfer_reference: settlement.transfer_reference,
            transfer_method: settlement.payment_method,
            transfer_date: settlement.paid_at.toISOString(),
            execution_idempotency_key: executionKey,
          });
          await writeDomainEvent(
            manager,
            'settlement.completed',
            `settlement:${settlement.id}:paid`,
            {
              settlement_id: settlement.id,
              teacher_id: settlement.teacher_id,
              payout_amount_minor: settlement.payout_amount_minor,
            },
          );
          await this.notify(
            manager,
            settlement.teacher_id,
            `settlement:${settlement.id}:teacher-paid`,
            'Settlement paid',
            `Settlement ${settlement.settlement_number} was paid.`,
            {
              settlement_id: settlement.id,
              payout_amount_minor: settlement.payout_amount_minor,
              currency: settlement.currency,
            },
          );
          return settlement;
        },
        { isolationLevel: 'SERIALIZABLE' },
      );
    } catch (error) {
      this.rethrowFinancialConstraint(error);
    }
  }

  public async list(
    filter: SettlementFilterDto,
    forcedTeacherId?: string,
  ): Promise<{ data: Settlement[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const query = this.settlements.createQueryBuilder('settlement');
    const teacherId = forcedTeacherId ?? filter.teacher_id;
    if (teacherId) query.where('settlement.teacher_id = :teacherId', { teacherId });
    if (filter.status) query.andWhere('settlement.status = :status', { status: filter.status });
    if (filter.currency)
      query.andWhere('settlement.currency = :currency', {
        currency: filter.currency.toUpperCase(),
      });
    if (filter.fiscal_period)
      query.andWhere('settlement.fiscal_period = :fiscalPeriod', {
        fiscalPeriod: filter.fiscal_period,
      });
    if (filter.search) {
      query.andWhere(
        `(settlement.settlement_number ILIKE :search OR settlement.transfer_reference ILIKE :search OR settlement.teacher_id::text ILIKE :search)`,
        { search: `%${filter.search.trim()}%` },
      );
    }
    const [data, total] = await query
      .orderBy('settlement.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /** Admin/teacher settlement inspection projection; ledger and audit evidence is read-only. */
  public async details(
    settlementId: string,
    forcedTeacherId?: string,
  ): Promise<Record<string, unknown>> {
    const settlement = await this.settlements.findOne({ where: { id: settlementId } });
    if (!settlement || (forcedTeacherId && settlement.teacher_id !== forcedTeacherId)) {
      throw new NotFoundException(biBody('Settlement not found', 'Settlement not found'));
    }
    const allocations = await this.dataSource.query(
      `
      SELECT membership.id, membership.amount_minor, membership.created_at,
             entry.id AS ledger_entry_id, entry.order_id, entry.account, entry.entry_type,
             entry.direction, entry.currency, entry.reference, entry.status, entry.available_at
      FROM teacher_settlement_entries membership
      JOIN financial_ledger_entries entry ON entry.id = membership.ledger_entry_id
      WHERE membership.settlement_id = $1 ORDER BY membership.created_at ASC, membership.id ASC
    `,
      [settlementId],
    );
    const ledgerEntries = await this.ledger.find({
      where: { settlement_id: settlementId },
      order: { created_at: 'ASC', id: 'ASC' },
    });
    const auditHistory = await this.dataSource.getRepository(PaymentAuditLog).find({
      where: { resource_type: 'settlement', resource_id: settlementId },
      order: { created_at: 'ASC', id: 'ASC' },
    });
    return { settlement, allocations, ledger_entries: ledgerEntries, audit_history: auditHistory };
  }

  /** Ledger-source balance projection used by the manual payroll queue. */
  public async teacherBalances(
    filter: SettlementFilterDto,
  ): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const params: unknown[] = [];
    let condition = "WHERE user_record.role = 'teacher'";
    if (filter.teacher_id) {
      params.push(filter.teacher_id);
      condition += ` AND user_record.id = $${params.length}`;
    }
    if (filter.search?.trim()) {
      params.push(`%${filter.search.trim()}%`);
      condition += ` AND (user_record.name ILIKE $${params.length} OR user_record.email ILIKE $${params.length})`;
    }
    const base = `
      FROM users user_record
      JOIN (
        SELECT teacher_id, currency,
          SUM(CASE WHEN account = 'teacher_payable' THEN CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END ELSE 0 END) AS pending_minor,
          SUM(CASE WHEN account = 'teacher_payable_available' THEN CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END ELSE 0 END) AS ledger_available_minor
        FROM financial_ledger_entries
        WHERE teacher_id IS NOT NULL
        GROUP BY teacher_id, currency
      ) balance ON balance.teacher_id = user_record.id
      LEFT JOIN (
        SELECT settlement.teacher_id, settlement.currency, SUM(membership.amount_minor) AS reserved_minor
        FROM teacher_settlements settlement
        JOIN teacher_settlement_entries membership ON membership.settlement_id = settlement.id
        WHERE settlement.status IN ('draft', 'approved')
        GROUP BY settlement.teacher_id, settlement.currency
      ) reserved ON reserved.teacher_id = balance.teacher_id AND reserved.currency = balance.currency
      LEFT JOIN (
        SELECT teacher_id, currency, SUM(payout_amount_minor) AS paid_minor
        FROM teacher_settlements WHERE status = 'paid'
        GROUP BY teacher_id, currency
      ) paid ON paid.teacher_id = balance.teacher_id AND paid.currency = balance.currency
      ${condition}`;
    const countRows = await this.dataSource.query(`SELECT COUNT(*)::int AS count ${base}`, params);
    const paginationParams = [...params, limit, (page - 1) * limit];
    const rows = await this.dataSource.query(
      `
      SELECT user_record.id AS teacher_id, user_record.name AS teacher_name, user_record.email AS teacher_email,
        balance.currency, balance.pending_minor::text AS pending_minor,
        GREATEST(balance.ledger_available_minor - COALESCE(reserved.reserved_minor, 0), 0)::text AS available_minor,
        COALESCE(reserved.reserved_minor, 0)::text AS reserved_minor,
        COALESCE(paid.paid_minor, 0)::text AS paid_minor
      ${base}
      ORDER BY user_record.name ASC, balance.currency ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `,
      paginationParams,
    );
    const total = Number(countRows[0]?.count ?? 0);
    return {
      data: rows,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Alert admins about teachers whose available (unpaid) balance has been
   * sitting for longer than `OVERDUE_PAYOUT_THRESHOLD_DAYS` with no
   * settlement created for it yet. A courtesy in-process gate skips the
   * (cheap, but pointless-to-repeat) full-table aggregate unless it has been
   * at least a day since the last check — safe even across multiple
   * instances, since the day-scoped dedupe key below makes the notification
   * itself idempotent regardless of how many instances happen to run it.
   *
   * Returns the number of teacher/currency balances flagged, for the
   * maintenance-cycle log.
   */
  public async notifyOverduePayouts(): Promise<number> {
    if (Date.now() - this.lastOverduePayoutCheckAt < OVERDUE_PAYOUT_CHECK_INTERVAL_MS) {
      return 0;
    }
    this.lastOverduePayoutCheckAt = Date.now();

    const rows = await this.dataSource.query<
      Array<{
        teacher_id: string;
        teacher_name: string;
        currency: string;
        available_minor: string;
        oldest_available_at: Date;
      }>
    >(
      `
      SELECT user_record.id AS teacher_id, user_record.name AS teacher_name, balance.currency,
        GREATEST(balance.ledger_available_minor - COALESCE(reserved.reserved_minor, 0), 0)::text AS available_minor,
        balance.oldest_available_at
      FROM (
        SELECT teacher_id, currency,
          SUM(CASE WHEN account = 'teacher_payable_available' THEN CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END ELSE 0 END) AS ledger_available_minor,
          MIN(available_at) FILTER (WHERE account = 'teacher_payable_available') AS oldest_available_at
        FROM financial_ledger_entries
        WHERE teacher_id IS NOT NULL
        GROUP BY teacher_id, currency
      ) balance
      JOIN users user_record ON user_record.id = balance.teacher_id
      LEFT JOIN (
        SELECT settlement.teacher_id, settlement.currency, SUM(membership.amount_minor) AS reserved_minor
        FROM teacher_settlements settlement
        JOIN teacher_settlement_entries membership ON membership.settlement_id = settlement.id
        WHERE settlement.status IN ('draft', 'approved')
        GROUP BY settlement.teacher_id, settlement.currency
      ) reserved ON reserved.teacher_id = balance.teacher_id AND reserved.currency = balance.currency
      WHERE balance.oldest_available_at IS NOT NULL
        AND balance.oldest_available_at <= NOW() - ($1 || ' days')::interval
      `,
      [OVERDUE_PAYOUT_THRESHOLD_DAYS],
    );

    const dayKey = new Date().toISOString().slice(0, 10);
    let flagged = 0;
    for (const row of rows) {
      const availableMinor = Number(row.available_minor);
      if (!Number.isSafeInteger(availableMinor) || availableMinor < this.minimumPayoutMinor) {
        continue;
      }
      flagged += 1;
      await this.adminNotifications.notifyAdmins(AdminNotificationEvent.PAYOUT_DUE, {
        title: 'Instructor payout due',
        message: `${row.teacher_name} has an unpaid available balance of ${fromMinorUnits(availableMinor).toFixed(2)} ${row.currency}, pending settlement for over ${OVERDUE_PAYOUT_THRESHOLD_DAYS} days.`,
        link: '/admin/finance/settlements',
        data: {
          teacher_id: row.teacher_id,
          currency: row.currency,
          available_minor: availableMinor,
        },
        dedupeKey: `${row.teacher_id}:${row.currency}:${dayKey}`,
      });
    }
    return flagged;
  }

  /**
   * Terminal draft/approved records retain their audit trail but release every
   * allocation immediately because selection only reserves active/paid rows.
   */
  public async cancel(
    settlementId: string,
    dto: SettlementTerminalDto,
    adminId: string,
  ): Promise<Settlement> {
    return this.closeWithoutPayment(settlementId, dto.reason, adminId, SettlementStatus.CANCELLED);
  }

  public async reject(
    settlementId: string,
    dto: SettlementTerminalDto,
    adminId: string,
  ): Promise<Settlement> {
    return this.closeWithoutPayment(settlementId, dto.reason, adminId, SettlementStatus.REJECTED);
  }

  public async releaseAvailableEarnings(limit = 500): Promise<number> {
    // One clock for the whole run: `available_at` is written from the application clock
    // (payment finalization), so it is compared with the application clock both when selecting
    // due rows and when re-checking a locked row. Mixing in the database's NOW() made a due
    // earning invisible whenever the database clock lagged the application's (E2E-1).
    const now = new Date();
    const due = await this.ledger
      .createQueryBuilder('entry')
      .where('entry.entry_type = :entryType', {
        entryType: LedgerEntryType.TEACHER_EARNING_PENDING,
      })
      .andWhere('entry.direction = :direction', { direction: LedgerDirection.CREDIT })
      .andWhere('entry.available_at <= :now', { now })
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM financial_ledger_entries reversal
          WHERE reversal.order_id = entry.order_id
            AND reversal.entry_type = :earningReversal
        )`,
        { earningReversal: LedgerEntryType.TEACHER_EARNING_REVERSAL },
      )
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM financial_ledger_entries release
          WHERE release.reference = 'release:' || entry.id::text || ':available'
        )`,
      )
      .orderBy('entry.available_at', 'ASC')
      .take(limit)
      .getMany();
    let released = 0;
    for (const entry of due) {
      await retryTransaction(this.dataSource, async (manager) => {
        await acquireTeacherFinancialLock(manager, entry.teacher_id);
        const order = await manager.findOne(Order, {
          where: { id: entry.order_id },
          lock: { mode: 'pessimistic_write' },
        });
        const locked = await manager.findOne(FinancialLedgerEntry, {
          where: { id: entry.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !locked ||
          locked.entry_type !== LedgerEntryType.TEACHER_EARNING_PENDING ||
          locked.direction !== LedgerDirection.CREDIT ||
          !locked.available_at ||
          locked.available_at > now
        ) {
          return;
        }
        if (!order || ![OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED].includes(order.status)) {
          return;
        }
        const reversed = await manager.exists(FinancialLedgerEntry, {
          where: {
            order_id: locked.order_id,
            entry_type: LedgerEntryType.TEACHER_EARNING_REVERSAL,
          },
        });
        if (reversed) return;
        const exists = await manager.findOne(FinancialLedgerEntry, {
          where: { reference: `release:${locked.id}:available` },
        });
        if (exists) return;
        const common = {
          order_id: locked.order_id,
          payment_id: locked.payment_id,
          teacher_id: locked.teacher_id,
          amount_minor: locked.amount_minor,
          currency: locked.currency,
          status: LedgerEntryStatus.POSTED,
          available_at: new Date(),
          source_channel: locked.source_channel,
          collection_party: locked.collection_party,
          settlement_id: null,
          metadata: { pending_entry_id: locked.id },
        };
        await manager.insert(FinancialLedgerEntry, [
          {
            ...common,
            account: 'teacher_payable',
            entry_type: LedgerEntryType.TEACHER_EARNING_PENDING,
            direction: LedgerDirection.DEBIT,
            reference: `release:${locked.id}:pending`,
          },
          {
            ...common,
            account: 'teacher_payable_available',
            entry_type: LedgerEntryType.TEACHER_EARNING_AVAILABLE,
            direction: LedgerDirection.CREDIT,
            reference: `release:${locked.id}:available`,
          },
        ]);
        await writeDomainEvent(
          manager,
          'teacher_earning.available',
          `ledger:${locked.id}:available-event`,
          {
            order_id: locked.order_id,
            teacher_id: locked.teacher_id,
            amount_minor: locked.amount_minor,
            currency: locked.currency,
          },
        );
        if (locked.teacher_id) {
          await this.notify(
            manager,
            locked.teacher_id,
            `ledger:${locked.id}:teacher-available`,
            'Earnings available',
            'A pending earning is now available for settlement.',
            {
              order_id: locked.order_id,
              amount_minor: locked.amount_minor,
              currency: locked.currency,
            },
          );
        }
        released += 1;
      });
    }
    return released;
  }

  private async accountBalanceWithManager(
    manager: EntityManager,
    teacherId: string,
    account: string,
    currency?: string,
  ): Promise<number> {
    const query = manager
      .getRepository(FinancialLedgerEntry)
      .createQueryBuilder('entry')
      .select(
        `COALESCE(SUM(CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END), 0)`,
        'value',
      )
      .where('entry.teacher_id = :teacherId', { teacherId })
      .andWhere('entry.account = :account', { account });
    if (currency) query.andWhere('entry.currency = :currency', { currency });
    const result = await query.getRawOne<SumRow>();
    return Number(result?.value ?? 0);
  }

  private async lock(manager: EntityManager, id: string): Promise<Settlement> {
    const settlement = await manager.findOne(Settlement, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!settlement) {
      throw new NotFoundException(biBody('Settlement not found', 'التسوية غير موجودة'));
    }
    return settlement;
  }

  private async firstOrderId(manager: EntityManager, settlementId: string): Promise<string | null> {
    const row = await manager
      .getRepository(SettlementEntry)
      .createQueryBuilder('membership')
      .innerJoin(FinancialLedgerEntry, 'entry', 'entry.id = membership.ledger_entry_id')
      .select('entry.order_id', 'order_id')
      .where('membership.settlement_id = :settlementId', { settlementId })
      .limit(1)
      .getRawOne<{ order_id: string }>();
    return row?.order_id ?? null;
  }

  private generateNumber(): string {
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `ST-${day}-${randomBytes(4).toString('hex').toUpperCase()}`;
  }

  private normalizedIdempotencyKey(key: string | undefined, fingerprint: string): string {
    const normalized = key?.trim();
    // Legacy callers keep their route, but new requests are never protected by
    // a random server-generated key. The deterministic fallback makes a retry
    // replay-safe; callers creating a distinct operation must send their own key.
    return normalized || `legacy:v1:${fingerprint}`;
  }

  private createFingerprint(dto: CreateSettlementDto): string {
    const payload = JSON.stringify({
      teacher_id: dto.teacher_id,
      ledger_entry_ids: [...(dto.ledger_entry_ids ?? [])].sort(),
      amount_minor: dto.amount_minor ?? null,
      deductions_minor: dto.deductions_minor ?? 0,
      receivable_offset_minor: dto.receivable_offset_minor ?? 0,
      payment_method: dto.payment_method.trim().toLowerCase(),
      fiscal_period: this.fiscalPeriod(dto.fiscal_period),
      currency: dto.currency?.trim().toUpperCase() ?? null,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  private fiscalPeriod(value?: string): string {
    const period = value?.trim() || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      throw new BadRequestException(
        biBody('Fiscal period must be YYYY-MM', 'Fiscal period must be YYYY-MM'),
      );
    }
    return period;
  }

  private normalizedTransferReference(reference: string): string {
    return reference.trim().toLowerCase();
  }

  private executionFingerprint(
    settlement: Settlement,
    transferReference: string,
    dto: PaySettlementDto,
    transferMethod: string,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          settlement_id: settlement.id,
          transfer_reference: this.normalizedTransferReference(transferReference),
          notes: dto.notes?.trim() ?? '',
          payment_method: transferMethod.toLowerCase(),
          currency: settlement.currency,
          payout_amount_minor: settlement.payout_amount_minor,
        }),
      )
      .digest('hex');
  }

  private normalizedExecutionKey(key: string | undefined, fingerprint: string): string {
    return key?.trim() || `legacy:v1:execute:${fingerprint}`;
  }

  /** Never leak PostgreSQL constraint names through the manual-payroll API. */
  private rethrowFinancialConstraint(error: unknown): never {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === '23505') {
      throw new ConflictException(
        biBody(
          'A matching transfer, request key, or active logical payout already exists',
          'A matching transfer, request key, or active logical payout already exists',
        ),
      );
    }
    if (code === '23514') {
      throw new BadRequestException(
        biBody(
          'Settlement allocations do not satisfy the available-balance rules',
          'Settlement allocations do not satisfy the available-balance rules',
        ),
      );
    }
    throw error;
  }

  private async closeWithoutPayment(
    settlementId: string,
    reason: string,
    adminId: string,
    targetStatus: SettlementStatus.CANCELLED | SettlementStatus.REJECTED,
  ): Promise<Settlement> {
    const candidate = await this.settlements.findOne({ where: { id: settlementId } });
    if (!candidate) {
      throw new NotFoundException(biBody('Settlement not found', 'Settlement not found'));
    }
    return retryTransaction(this.dataSource, async (manager) => {
      await acquireTeacherFinancialLock(manager, candidate.teacher_id);
      const settlement = await this.lock(manager, settlementId);
      if (settlement.status === targetStatus) return settlement;
      if (![SettlementStatus.DRAFT, SettlementStatus.APPROVED].includes(settlement.status)) {
        throw new ConflictException(
          biBody(
            'Only a draft or approved settlement can be cancelled or rejected',
            'يمكن إلغاء أو رفض التسوية المسودة أو المعتمدة فقط',
          ),
        );
      }
      settlement.status = targetStatus;
      await manager.save(Settlement, settlement);
      await this.audit(manager, adminId, `settlement_${targetStatus}`, settlement, {
        reason: reason.trim(),
      });
      await writeDomainEvent(
        manager,
        `settlement.${targetStatus}`,
        `settlement:${settlement.id}:${targetStatus}`,
        {
          settlement_id: settlement.id,
          teacher_id: settlement.teacher_id,
          reason: reason.trim(),
        },
      );
      return settlement;
    });
  }

  private async audit(
    manager: EntityManager,
    actorId: string,
    action: string,
    settlement: Settlement,
    details: Record<string, unknown>,
  ): Promise<void> {
    await writePaymentAudit(manager, {
      actorId,
      action,
      resourceType: 'settlement',
      resourceId: settlement.id,
      details: { teacher_id: settlement.teacher_id, ...details },
    });
  }

  private async notify(
    manager: EntityManager,
    userId: string,
    dedupeKey: string,
    title: string,
    message: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(Notification)
      .values({
        dedupe_key: dedupeKey,
        origin: NotificationOrigin.SYSTEM,
        source_event: 'settlement_notification',
        user_id: userId,
        type: NotificationType.PURCHASE,
        title,
        message,
        data,
        is_read: false,
        sent_at: new Date(),
        read_at: null,
        sms_sent: false,
        sms_to: null,
        status: NotificationStatus.SENT,
        attempts: 0,
        error_message: null,
        delivered_at: null,
      } as never)
      .orIgnore()
      .execute();
  }
}
