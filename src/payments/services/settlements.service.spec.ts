import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';

import { LedgerDirection, LedgerEntryType, OrderStatus, SettlementStatus } from '../entities';
import { SettlementsService } from './settlements.service';

describe('SettlementsService teacher wallet', () => {
  it('uses teacher-owned ledger balances and never serializes platform-collected sales', async () => {
    const service = new SettlementsService(
      {} as Repository<never>,
      {
        query: jest.fn().mockResolvedValue([
          {
            currency: 'EGP',
            pending_balance_minor: '1000',
            available_balance_minor: '2000',
            lifetime_earnings_minor: '4000',
            paid_out_minor: '-500',
            refunded_reversed_minor: '-200',
            teacher_collected_sales_minor: '700',
            outstanding_platform_receivable_minor: '300',
          },
        ]),
      } as unknown as Repository<never>,
      { manager: {} } as DataSource,
      { get: jest.fn().mockReturnValue('10000') } as unknown as ConfigService,
    );
    const result = await service.getTeacherWallet('teacher-a');

    expect(result).toEqual({
      currency: 'EGP',
      pending_balance_minor: 1_000,
      available_balance_minor: 2_000,
      lifetime_earnings_minor: 4_000,
      paid_out_minor: 500,
      refunded_reversed_minor: 200,
      teacher_collected_sales_minor: 700,
      outstanding_platform_receivable_minor: 300,
      next_settlement_date: null,
      balances: [
        {
          currency: 'EGP',
          pending_balance_minor: 1_000,
          available_balance_minor: 2_000,
          lifetime_earnings_minor: 4_000,
          paid_out_minor: 500,
          refunded_reversed_minor: 200,
          teacher_collected_sales_minor: 700,
          outstanding_platform_receivable_minor: 300,
        },
      ],
    });
    expect(result).not.toHaveProperty('platform_collected_sales_minor');
  });

  it('does not combine balances from different currencies into a legacy total', async () => {
    const service = new SettlementsService(
      {} as Repository<never>,
      {
        query: jest.fn().mockResolvedValue([
          {
            currency: 'EGP', pending_balance_minor: '0', available_balance_minor: '100', lifetime_earnings_minor: '100', paid_out_minor: '0', refunded_reversed_minor: '0', teacher_collected_sales_minor: '0', outstanding_platform_receivable_minor: '0',
          },
          {
            currency: 'USD', pending_balance_minor: '0', available_balance_minor: '200', lifetime_earnings_minor: '200', paid_out_minor: '0', refunded_reversed_minor: '0', teacher_collected_sales_minor: '0', outstanding_platform_receivable_minor: '0',
          },
        ]),
      } as unknown as Repository<never>,
      { manager: {} } as DataSource,
      { get: jest.fn().mockReturnValue('10000') } as unknown as ConfigService,
    );
    await expect(service.getTeacherWallet('teacher-a')).resolves.toMatchObject({
      currency: null,
      available_balance_minor: null,
      balances: expect.arrayContaining([
        expect.objectContaining({ currency: 'EGP', available_balance_minor: 100 }),
        expect.objectContaining({ currency: 'USD', available_balance_minor: 200 }),
      ]),
    });
  });
});

describe('SettlementsService stage-one safeguards', () => {
  const config = { get: jest.fn().mockReturnValue('0') } as unknown as ConfigService;

  function insertBuilder() {
    const builder = {
      insert: jest.fn(),
      into: jest.fn(),
      values: jest.fn(),
      orIgnore: jest.fn(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    builder.insert.mockReturnValue(builder);
    builder.into.mockReturnValue(builder);
    builder.values.mockReturnValue(builder);
    builder.orIgnore.mockReturnValue(builder);
    return builder;
  }

  it('cancels a draft settlement without deleting its allocation, so it no longer reserves balance', async () => {
    const settlement = {
      id: 'settlement-1',
      teacher_id: 'teacher-1',
      status: SettlementStatus.DRAFT,
    };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(settlement),
      save: jest.fn().mockResolvedValue(settlement),
      insert: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(insertBuilder()),
    };
    const dataSource = {
      transaction: jest.fn((...args: unknown[]) =>
        (args.at(-1) as (m: typeof manager) => unknown)(manager),
      ),
      manager,
    };
    const service = new SettlementsService(
      { findOne: jest.fn().mockResolvedValue(settlement) } as unknown as Repository<never>,
      {} as Repository<never>,
      dataSource as unknown as DataSource,
      config,
    );

    await expect(
      service.cancel('settlement-1', { reason: 'duplicate request' }, 'admin-1'),
    ).resolves.toMatchObject({
      status: SettlementStatus.CANCELLED,
    });
    expect(manager.save).toHaveBeenCalledWith(expect.anything(), settlement);
  });

  it('releases a due pending earning once and posts an append-only transfer pair', async () => {
    const dueEntry = {
      id: 'pending-entry-1',
      order_id: 'order-1',
      payment_id: 'payment-1',
      teacher_id: 'teacher-1',
      amount_minor: 1250,
      currency: 'EGP',
      entry_type: LedgerEntryType.TEACHER_EARNING_PENDING,
      direction: LedgerDirection.CREDIT,
      available_at: new Date(Date.now() - 1_000),
      source_channel: 'manual',
      collection_party: 'platform',
    };
    const dueBuilder = {
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      take: jest.fn(),
      getMany: jest.fn().mockResolvedValue([dueEntry]),
    };
    dueBuilder.where.mockReturnValue(dueBuilder);
    dueBuilder.andWhere.mockReturnValue(dueBuilder);
    dueBuilder.orderBy.mockReturnValue(dueBuilder);
    dueBuilder.take.mockReturnValue(dueBuilder);
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn((entity: unknown) =>
        entity === Object ? undefined : Promise.resolve(entity ? dueEntry : undefined),
      ),
      exists: jest.fn().mockResolvedValue(false),
      insert: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(insertBuilder()),
    };
    // Shared financial lock order is teacher advisory, order, then ledger.
    manager.findOne
      .mockResolvedValueOnce({ id: 'order-1', status: OrderStatus.PAID })
      .mockResolvedValueOnce(dueEntry)
      .mockResolvedValueOnce(null);
    const dataSource = {
      transaction: jest.fn((...args: unknown[]) =>
        (args.at(-1) as (m: typeof manager) => unknown)(manager),
      ),
      manager,
    };
    const service = new SettlementsService(
      {} as Repository<never>,
      { createQueryBuilder: jest.fn().mockReturnValue(dueBuilder) } as unknown as Repository<never>,
      dataSource as unknown as DataSource,
      config,
    );

    await expect(service.releaseAvailableEarnings()).resolves.toBe(1);
    expect(manager.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          entry_type: LedgerEntryType.TEACHER_EARNING_AVAILABLE,
          amount_minor: 1250,
          currency: 'EGP',
        }),
      ]),
    );
  });

  it('keeps an idempotency fingerprint stable when ledger-entry order differs', () => {
    const service = new SettlementsService(
      {} as Repository<never>,
      {} as Repository<never>,
      { manager: {} } as DataSource,
      config,
    );
    const left = (service as never).createFingerprint({
      teacher_id: 'teacher-1',
      ledger_entry_ids: ['b', 'a'],
      payment_method: 'bank',
    });
    const right = (service as never).createFingerprint({
      teacher_id: 'teacher-1',
      ledger_entry_ids: ['a', 'b'],
      payment_method: 'bank',
    });
    expect(left).toBe(right);
  });
});
