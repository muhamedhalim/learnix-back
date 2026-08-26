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

  /**
   * AUD-030: this used to assert `o.status = 'paid'` verbatim, which pinned the
   * defect in place — a refunded sale was excluded from the report entirely
   * instead of being netted, so its gross and its refund both disappeared and
   * the report "balanced" by losing both halves. The recognition guarantees
   * that were always correct (paid_at, finalised payment) are kept; the
   * population is now the canonical settled set.
   */
  it('recognizes revenue from settled orders with finalised payments at paid_at', async () => {
    await service.financialReport({
      from: '2026-01-01', to: '2026-01-31', currency: 'EGP', page: 1, limit: 20,
    });

    const queryText = dataSource.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(queryText).toContain("o.status IN ('paid','partially_refunded','refunded')");
    expect(queryText).toContain("payment.status IN ('completed','refunded')");
    expect(queryText).toContain('o.paid_at IS NOT NULL');
    expect(queryText).toContain('o.paid_at >= $1');
    expect(queryText).not.toContain('o.created_at >=');
  });

  it('nets refunds out of revenue rather than dropping refunded sales', async () => {
    await service.financialReport({ page: 1, limit: 20 });

    const queryText = dataSource.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    // The report must subtract refunds explicitly...
    expect(queryText).toContain(
      '(COALESCE(SUM(final_amount_minor),0)-COALESCE(SUM(refunded_amount_minor),0))',
    );
    // ...and must never again narrow the population to plain 'paid'.
    expect(queryText).not.toContain("o.status = 'paid'");
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
