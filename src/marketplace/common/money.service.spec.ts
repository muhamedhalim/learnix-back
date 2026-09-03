import { CurrencyRegistryService } from './currency-registry.service';
import { MarketplaceMoneyService } from './money.service';

function buildRegistry(enabledCodes: string[] = ['EGP', 'KWD']): jest.Mocked<CurrencyRegistryService> {
  return {
    resolve: jest.fn(async (code: string) => {
      if (!enabledCodes.includes(code)) throw new Error(`unknown currency ${code}`);
      return { code, minor_unit_exponent: code === 'KWD' ? 3 : 2 } as never;
    }),
  } as unknown as jest.Mocked<CurrencyRegistryService>;
}

describe('MarketplaceMoneyService', () => {
  it('refuses to combine amounts across two currencies (FR-127)', () => {
    const service = new MarketplaceMoneyService(buildRegistry());
    expect(() =>
      service.add({ amountMinor: 100, currency: 'EGP' }, { amountMinor: 100, currency: 'KWD' }),
    ).toThrow();
  });

  it('adds and subtracts within one currency', () => {
    const service = new MarketplaceMoneyService(buildRegistry());
    expect(service.add({ amountMinor: 100, currency: 'EGP' }, { amountMinor: 50, currency: 'EGP' })).toBe(150);
    expect(service.subtract({ amountMinor: 100, currency: 'EGP' }, { amountMinor: 30, currency: 'EGP' })).toBe(70);
  });

  describe('splitCommission', () => {
    it('reproduces the worked example: 50000 minor units at 20% yields 10000/40000', async () => {
      const service = new MarketplaceMoneyService(buildRegistry());
      const result = await service.splitCommission(50_000, 2000, 'EGP');
      expect(result).toEqual({ commissionMinor: 10_000, instructorEarningMinor: 40_000 });
    });

    it('always allocates the rounding residue to the instructor, never the platform', async () => {
      const service = new MarketplaceMoneyService(buildRegistry());
      // 1001 * 3000 / 10000 = 300.3 -> floors to 300, leaving 701 (not 700) for the instructor.
      const result = await service.splitCommission(1001, 3000, 'EGP');
      expect(result.commissionMinor).toBe(300);
      expect(result.instructorEarningMinor).toBe(701);
      expect(result.commissionMinor + result.instructorEarningMinor).toBe(1001);
    });

    it('conserves the captured amount exactly across a sweep of odd amounts (FR-327)', async () => {
      const service = new MarketplaceMoneyService(buildRegistry());
      for (let captured = 1; captured <= 500; captured += 7) {
        const result = await service.splitCommission(captured, 3333, 'EGP');
        expect(result.commissionMinor + result.instructorEarningMinor).toBe(captured);
      }
    });

    it('rejects an unknown or disabled currency before splitting anything', async () => {
      const service = new MarketplaceMoneyService(buildRegistry(['EGP']));
      await expect(service.splitCommission(1000, 3000, 'USD')).rejects.toThrow();
    });

    it('rejects a rate outside 0-10000 basis points', async () => {
      const service = new MarketplaceMoneyService(buildRegistry());
      await expect(service.splitCommission(1000, 10_001, 'EGP')).rejects.toThrow();
      await expect(service.splitCommission(1000, -1, 'EGP')).rejects.toThrow();
    });
  });
});
