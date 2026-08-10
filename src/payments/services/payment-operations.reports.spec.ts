import { PaymentOperationsService } from './payment-operations.service';

describe('PaymentOperationsService financial reporting', () => {
  const dataSource = { query: jest.fn() };
  const service = new PaymentOperationsService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    dataSource as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  beforeEach(() => {
    dataSource.query.mockReset();
    dataSource.query.mockResolvedValue([]);
  });

  it('recognizes revenue only from paid orders with completed payments at paid_at', async () => {
    await service.financialReport({
      from: '2026-01-01', to: '2026-01-31', currency: 'EGP', page: 1, limit: 20,
    });

    const queryText = dataSource.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(queryText).toContain("o.status = 'paid'");
    expect(queryText).toContain("payment.status = 'completed'");
    expect(queryText).toContain('o.paid_at IS NOT NULL');
    expect(queryText).toContain('o.paid_at >= $1');
    expect(queryText).not.toContain('o.created_at >=');
  });

  it('keeps all summaries and ledger balances currency-scoped', async () => {
    await service.financialReport({ currency: 'USD', page: 1, limit: 20 });

    const queryText = dataSource.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(queryText).toContain('GROUP BY currency');
    expect(queryText).toContain('entry.currency = $');
    expect(queryText).toContain('settlement.currency = $');
  });

  it('degrades one failed widget to a warning without losing successful results', async () => {
    dataSource.query
      .mockResolvedValueOnce([{ currency: 'EGP', order_count: '1' }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('trend query failed'))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(service.financialReport({ page: 1, limit: 20 })).resolves.toMatchObject({
      summary: [{ currency: 'EGP' }],
      widget_errors: [{ widget: 'revenue_trends' }],
    });
  });
});
