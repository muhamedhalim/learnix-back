import { MarketplaceSettlementListener } from './marketplace-settlement.listener';

function buildListener(
  settleImpl: (...args: unknown[]) => Promise<unknown>,
  markFailedImpl: (...args: unknown[]) => Promise<unknown> = async () => 'failed',
) {
  const manager = {};
  const dataSource = {
    transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)),
  };
  const settlement = { settle: jest.fn(settleImpl), markFailed: jest.fn(markFailedImpl) };
  const listener = new MarketplaceSettlementListener(dataSource as never, settlement as never);
  return { listener, dataSource, settlement };
}

describe('MarketplaceSettlementListener', () => {
  it('calls settle() with the outbox payload inside its own transaction', async () => {
    const { listener, settlement } = buildListener(async () => 'settled');

    await listener.handleMarketplaceItemSucceeded({
      payment_id: 'payment-1',
      order_id: 'order-1',
      verified_amount_minor: 5000,
      verified_currency: 'EGP',
    });

    expect(settlement.settle).toHaveBeenCalledWith('payment-1', 5000, 'EGP', expect.anything());
  });

  it('ignores a payload with no payment_id rather than throwing', async () => {
    const { listener, settlement } = buildListener(async () => 'settled');
    await listener.handleMarketplaceItemSucceeded({} as never);
    expect(settlement.settle).not.toHaveBeenCalled();
  });

  it('propagates a settlement failure so the outbox drainer retries the event', async () => {
    const { listener } = buildListener(async () => {
      throw new Error('db unavailable');
    });

    await expect(
      listener.handleMarketplaceItemSucceeded({ payment_id: 'payment-1', order_id: 'order-1', verified_amount_minor: 5000, verified_currency: 'EGP' }),
    ).rejects.toThrow('db unavailable');
  });

  describe('handleMarketplaceItemFailed', () => {
    it('calls markFailed() with the outbox payload inside its own transaction', async () => {
      const { listener, settlement } = buildListener(async () => 'settled', async () => 'failed');

      await listener.handleMarketplaceItemFailed({ payment_id: 'payment-1', order_id: 'order-1' });

      expect(settlement.markFailed).toHaveBeenCalledWith('payment-1', expect.anything());
    });

    it('ignores a payload with no payment_id rather than throwing', async () => {
      const { listener, settlement } = buildListener(async () => 'settled');
      await listener.handleMarketplaceItemFailed({} as never);
      expect(settlement.markFailed).not.toHaveBeenCalled();
    });

    it('propagates a failure so the outbox drainer retries the event', async () => {
      const { listener } = buildListener(async () => 'settled', async () => {
        throw new Error('db unavailable');
      });

      await expect(
        listener.handleMarketplaceItemFailed({ payment_id: 'payment-1', order_id: 'order-1' }),
      ).rejects.toThrow('db unavailable');
    });
  });
});
