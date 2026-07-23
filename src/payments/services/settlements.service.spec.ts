import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';

import {
  FinancialLedgerEntry,
  LedgerDirection,
  Order,
  Settlement,
  SettlementEntry,
  SettlementStatus,
} from '../entities';
import { SettlementsService } from './settlements.service';

describe('SettlementsService', () => {
  it('clears the full payable and posts a balanced payout with deductions and offsets', async () => {
    const settlement = {
      id: 'settlement-1',
      settlement_number: 'ST-1',
      teacher_id: 'teacher-1',
      gross_amount_minor: 10_000,
      deductions_minor: 500,
      receivable_offset_minor: 1_000,
      payout_amount_minor: 8_500,
      currency: 'EGP',
      status: SettlementStatus.APPROVED,
    } as Settlement;
    let settlementQueryCount = 0;
    const inserted: Array<{ entity: unknown; values: unknown }> = [];

    const eventBuilder = () => {
      const chain = {
        insert: jest.fn(() => chain),
        into: jest.fn(() => chain),
        values: jest.fn(() => chain),
        orIgnore: jest.fn(() => chain),
        execute: jest.fn().mockResolvedValue({ identifiers: [] }),
      };
      return chain;
    };
    const manager = {
      findOne: jest.fn((entity: unknown) => {
        if (entity === Settlement) return Promise.resolve(settlement);
        if (entity === Order) return Promise.resolve({ id: 'order-1' });
        return Promise.resolve(null);
      }),
      save: jest.fn((_entity: unknown, value: unknown) => Promise.resolve(value)),
      insert: jest.fn((entity: unknown, values: unknown) => {
        inserted.push({ entity, values });
        return Promise.resolve({ identifiers: [] });
      }),
      createQueryBuilder: jest.fn(eventBuilder),
      getRepository: jest.fn((entity: unknown) => {
        if (entity !== SettlementEntry) throw new Error('Unexpected repository');
        settlementQueryCount += 1;
        const call = settlementQueryCount;
        const chain = {
          createQueryBuilder: jest.fn(() => chain),
          innerJoin: jest.fn(() => chain),
          select: jest.fn(() => chain),
          where: jest.fn(() => chain),
          getRawMany: jest.fn().mockResolvedValue([{ order_id: 'order-1' }]),
          getCount: jest.fn().mockResolvedValue(0),
          limit: jest.fn(() => chain),
          getRawOne: jest.fn().mockResolvedValue(call === 3 ? { order_id: 'order-1' } : null),
        };
        return chain;
      }),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(
        (first: unknown, second?: (transactionManager: EntityManager) => Promise<unknown>) => {
          const work =
            typeof first === 'function'
              ? (first as (transactionManager: EntityManager) => Promise<unknown>)
              : second!;
          return work(manager);
        },
      ),
    } as unknown as DataSource;
    const service = new SettlementsService({} as never, {} as never, dataSource, {
      get: jest.fn().mockReturnValue('0'),
    } as unknown as ConfigService);

    await service.markPaid(settlement.id, { transfer_reference: 'bank-transfer-1' }, 'admin-1');

    const ledgerInsert = inserted.find((entry) => entry.entity === FinancialLedgerEntry)
      ?.values as Array<Partial<FinancialLedgerEntry>>;
    expect(ledgerInsert).toBeDefined();
    expect(
      ledgerInsert.find((entry) => entry.account === 'teacher_payable_available'),
    ).toMatchObject({
      amount_minor: 10_000,
      direction: LedgerDirection.DEBIT,
    });
    expect(ledgerInsert.find((entry) => entry.account === 'platform_cash')).toMatchObject({
      amount_minor: 8_500,
      direction: LedgerDirection.CREDIT,
    });

    const debits = ledgerInsert
      .filter((entry) => entry.direction === LedgerDirection.DEBIT)
      .reduce((sum, entry) => sum + Number(entry.amount_minor), 0);
    const credits = ledgerInsert
      .filter((entry) => entry.direction === LedgerDirection.CREDIT)
      .reduce((sum, entry) => sum + Number(entry.amount_minor), 0);
    expect(debits).toBe(credits);
    expect(settlement.status).toBe(SettlementStatus.PAID);
  });
});
