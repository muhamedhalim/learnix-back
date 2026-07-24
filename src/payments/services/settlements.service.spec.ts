import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';

import { SettlementsService } from './settlements.service';

describe('SettlementsService teacher wallet', () => {
  it('uses teacher-owned ledger balances and never serializes platform-collected sales', async () => {
    const service = new SettlementsService(
      {} as Repository<never>,
      {} as Repository<never>,
      { manager: {} } as DataSource,
      { get: jest.fn().mockReturnValue('10000') } as unknown as ConfigService,
    );
    jest.spyOn(service as never, 'accountBalance').mockImplementation(
      async (_teacherId: string, account: string) =>
        ({ teacher_payable: 1_000, teacher_payable_available: 2_000, platform_receivable: 300 })[
          account
        ] ?? 0,
    );
    jest.spyOn(service as never, 'lifetimeEarnings').mockResolvedValue(4_000);
    jest.spyOn(service as never, 'entryNet').mockResolvedValueOnce(-500).mockResolvedValueOnce(-200).mockResolvedValueOnce(700);

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
    });
    expect(result).not.toHaveProperty('platform_collected_sales_minor');
  });
});
