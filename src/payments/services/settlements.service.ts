import { randomBytes } from 'node:crypto';

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
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { biBody } from '../../i18n/error-translator.util';
import { Notification } from '../../notifications/entities/notification.entity';
import { NotificationStatus } from '../../notifications/entities/notification-status.enum';
import { NotificationType } from '../../notifications/entities/notification-type.enum';
import { CreateSettlementDto, PaySettlementDto, SettlementFilterDto } from '../dto';
import {
  CollectionParty,
  FinancialLedgerEntry,
  LedgerDirection,
  LedgerEntryStatus,
  LedgerEntryType,
  Order,
  PaymentAuditLog,
  PaymentChannel,
  PaymentDomainEvent,
  Settlement,
  SettlementEntry,
  SettlementStatus,
} from '../entities';

interface SumRow {
  value: string | null;
}

/**
 * Teacher-safe wallet projection.  This deliberately contains only balances
 * and events attributable to the authenticated teacher; platform collection
 * totals are an admin-finance concern and must never leave the teacher API.
 */
export interface TeacherWalletSummary {
  currency: string;
  pending_balance_minor: number;
  available_balance_minor: number;
  lifetime_earnings_minor: number;
  paid_out_minor: number;
  refunded_reversed_minor: number;
  teacher_collected_sales_minor: number;
  outstanding_platform_receivable_minor: number;
  next_settlement_date: null;
}

@Injectable()
export class SettlementsService {
  private readonly minimumPayoutMinor: number;

  constructor(
    @InjectRepository(Settlement)
    private readonly settlements: Repository<Settlement>,
    @InjectRepository(FinancialLedgerEntry)
    private readonly ledger: Repository<FinancialLedgerEntry>,
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.minimumPayoutMinor = Math.max(
      0,
      Number.parseInt(config.get<string>('MINIMUM_SETTLEMENT_MINOR') ?? '10000', 10),
    );
  }

  public async getTeacherWallet(
    teacherId: string,
  ): Promise<TeacherWalletSummary> {
    const [
      pending,
      available,
      lifetime,
      paid,
      reversed,
      teacherCollected,
      receivable,
    ] = await Promise.all([
      this.accountBalance(teacherId, 'teacher_payable'),
      this.accountBalance(teacherId, 'teacher_payable_available'),
      this.lifetimeEarnings(teacherId),
      this.entryNet(teacherId, LedgerEntryType.PAYOUT),
      this.entryNet(teacherId, LedgerEntryType.TEACHER_EARNING_REVERSAL),
      this.entryNet(teacherId, LedgerEntryType.TEACHER_COLLECTED_SALE),
      this.accountBalance(teacherId, 'platform_receivable'),
    ]);
    return {
      currency: 'EGP',
      pending_balance_minor: pending,
      available_balance_minor: available,
      lifetime_earnings_minor: lifetime,
      paid_out_minor: Math.abs(paid),
      refunded_reversed_minor: Math.abs(reversed),
      teacher_collected_sales_minor: teacherCollected,
      outstanding_platform_receivable_minor: receivable,
      next_settlement_date: null,
    };
  }

  public async create(dto: CreateSettlementDto, adminId: string): Promise<Settlement> {
    return retryTransaction(this.dataSource, async (manager) => {
      const query = manager
        .getRepository(FinancialLedgerEntry)
        .createQueryBuilder('entry')
        .setLock('pessimistic_write')
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
          `NOT EXISTS (
            SELECT 1 FROM teacher_settlement_entries membership
            WHERE membership.ledger_entry_id = entry.id
          )`,
        );
      if (dto.ledger_entry_ids?.length) {
        query.andWhere('entry.id IN (:...entryIds)', { entryIds: dto.ledger_entry_ids });
      }
      const entries = await query.orderBy('entry.created_at', 'ASC').getMany();
      if (entries.length === 0) {
        throw new ConflictException(
          biBody(
            'No available earnings are eligible for settlement',
            'لا توجد أرباح متاحة مؤهلة للتسوية',
          ),
        );
      }
      if (dto.ledger_entry_ids?.length && entries.length !== new Set(dto.ledger_entry_ids).size) {
        throw new ConflictException(
          biBody(
            'One or more ledger entries are unavailable or already settled',
            'قيد أو أكثر غير متاح أو تمت تسويته',
          ),
        );
      }
      const currency = entries[0]?.currency ?? 'EGP';
      if (entries.some((entry) => entry.currency !== currency)) {
        throw new BadRequestException(
          biBody(
            'Settlement entries must use one currency',
            'يجب أن تستخدم قيود التسوية عملة واحدة',
          ),
        );
      }
      const gross = entries.reduce((sum, entry) => sum + entry.amount_minor, 0);
      const deductions = dto.deductions_minor ?? 0;
      const receivableOffset = dto.receivable_offset_minor ?? 0;
      const outstandingReceivable = await this.accountBalanceWithManager(
        manager,
        dto.teacher_id,
        'platform_receivable',
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
          teacher_id: dto.teacher_id,
          gross_amount_minor: gross,
          deductions_minor: deductions,
          receivable_offset_minor: receivableOffset,
          payout_amount_minor: payout,
          currency,
          status: SettlementStatus.DRAFT,
          payment_method: dto.payment_method,
          transfer_reference: null,
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
        entries.map((entry) => ({
          settlement_id: settlement.id,
          ledger_entry_id: entry.id,
        })),
      );
      await this.audit(manager, adminId, 'settlement_created', settlement, {
        ledger_entry_ids: entries.map((entry) => entry.id),
      });
      await this.event(manager, 'settlement.created', `settlement:${settlement.id}:created`, {
        settlement_id: settlement.id,
        teacher_id: settlement.teacher_id,
        payout_amount_minor: settlement.payout_amount_minor,
      });
      return settlement;
    });
  }

  public async approve(settlementId: string, adminId: string): Promise<Settlement> {
    return retryTransaction(this.dataSource, async (manager) => {
      const settlement = await this.lock(manager, settlementId);
      if (settlement.status !== SettlementStatus.DRAFT) {
        throw new ConflictException(
          biBody('Only a draft settlement can be approved', 'يمكن اعتماد التسوية المسودة فقط'),
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
    return retryTransaction(this.dataSource, async (manager) => {
      const settlement = await this.lock(manager, settlementId);
      if (settlement.status === SettlementStatus.PAID) return settlement;
      if (settlement.status !== SettlementStatus.APPROVED) {
        throw new ConflictException(
          biBody('Settlement must be approved before payment', 'يجب اعتماد التسوية قبل الدفع'),
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
      settlement.status = SettlementStatus.PAID;
      settlement.transfer_reference = dto.transfer_reference.trim();
      settlement.paid_by = adminId;
      settlement.paid_at = new Date();
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
      });
      await this.event(manager, 'settlement.completed', `settlement:${settlement.id}:paid`, {
        settlement_id: settlement.id,
        teacher_id: settlement.teacher_id,
        payout_amount_minor: settlement.payout_amount_minor,
      });
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
    });
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

  public async releaseAvailableEarnings(limit = 500): Promise<number> {
    const due = await this.ledger
      .createQueryBuilder('entry')
      .where('entry.entry_type = :entryType', {
        entryType: LedgerEntryType.TEACHER_EARNING_PENDING,
      })
      .andWhere('entry.direction = :direction', { direction: LedgerDirection.CREDIT })
      .andWhere('entry.available_at <= NOW()')
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
        const locked = await manager.findOne(FinancialLedgerEntry, {
          where: { id: entry.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) return;
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
        await this.event(
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

  private async accountBalance(teacherId: string, account: string): Promise<number> {
    return this.accountBalanceWithManager(this.dataSource.manager, teacherId, account);
  }

  private async accountBalanceWithManager(
    manager: EntityManager,
    teacherId: string,
    account: string,
  ): Promise<number> {
    const result = await manager
      .getRepository(FinancialLedgerEntry)
      .createQueryBuilder('entry')
      .select(
        `COALESCE(SUM(CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END), 0)`,
        'value',
      )
      .where('entry.teacher_id = :teacherId', { teacherId })
      .andWhere('entry.account = :account', { account })
      .getRawOne<SumRow>();
    return Number(result?.value ?? 0);
  }

  private async entryNet(teacherId: string, type: LedgerEntryType): Promise<number> {
    const result = await this.ledger
      .createQueryBuilder('entry')
      .select(
        `COALESCE(SUM(CASE WHEN entry.direction = 'credit' THEN entry.amount_minor ELSE -entry.amount_minor END), 0)`,
        'value',
      )
      .where('entry.teacher_id = :teacherId', { teacherId })
      .andWhere('entry.entry_type = :type', { type })
      .getRawOne<SumRow>();
    return Number(result?.value ?? 0);
  }

  private async lifetimeEarnings(teacherId: string): Promise<number> {
    const result = await this.ledger
      .createQueryBuilder('entry')
      .select('COALESCE(SUM(entry.amount_minor), 0)', 'value')
      .where('entry.teacher_id = :teacherId', { teacherId })
      .andWhere('entry.direction = :credit', { credit: LedgerDirection.CREDIT })
      .andWhere(
        `(
          entry.entry_type = :pending
          OR (
            entry.entry_type = :available
            AND entry.reference LIKE 'order:%'
          )
        )`,
        {
          pending: LedgerEntryType.TEACHER_EARNING_PENDING,
          available: LedgerEntryType.TEACHER_EARNING_AVAILABLE,
        },
      )
      .getRawOne<SumRow>();
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

  private async audit(
    manager: EntityManager,
    actorId: string,
    action: string,
    settlement: Settlement,
    details: Record<string, unknown>,
  ): Promise<void> {
    await manager.insert(PaymentAuditLog, {
      actor_id: actorId,
      action,
      resource_type: 'settlement',
      resource_id: settlement.id,
      details: { teacher_id: settlement.teacher_id, ...details },
      ip_address: null,
    });
  }

  private async event(
    manager: EntityManager,
    name: string,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(PaymentDomainEvent)
      .values({
        event_name: name,
        dedupe_key: dedupeKey,
        payload: payload as never,
        published_at: null,
        attempts: 0,
        last_error: null,
      })
      .orIgnore()
      .execute();
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
