import type { Repository } from 'typeorm';

import { CurrencyRegistryService } from './currency-registry.service';
import { MarketplaceCurrency } from '../earnings/entities/marketplace-currency.entity';

function buildService(rows: Partial<MarketplaceCurrency>[]): {
  service: CurrencyRegistryService;
  repo: jest.Mocked<Repository<MarketplaceCurrency>>;
} {
  const repo = {
    findOne: jest.fn(async ({ where }: { where: { code: string } }) =>
      rows.find((r) => r.code === where.code) ?? null,
    ),
    find: jest.fn(async () => rows.filter((r) => r.is_enabled)),
  } as unknown as jest.Mocked<Repository<MarketplaceCurrency>>;
  return { service: new CurrencyRegistryService(repo), repo };
}

describe('CurrencyRegistryService', () => {
  const egp: Partial<MarketplaceCurrency> = {
    code: 'EGP',
    minor_unit_exponent: 2,
    is_enabled: true,
    min_price_minor: 5000,
    max_price_minor: 2000000,
    min_payout_minor: 50000,
  };

  it('resolves an enabled currency by code', async () => {
    const { service } = buildService([egp]);
    await expect(service.resolve('EGP')).resolves.toMatchObject({ code: 'EGP', minor_unit_exponent: 2 });
  });

  it('rejects an unknown currency code rather than assuming a default', async () => {
    const { service } = buildService([egp]);
    await expect(service.resolve('USD')).rejects.toThrow();
  });

  it('rejects a disabled currency code even when the row exists', async () => {
    const { service } = buildService([{ ...egp, code: 'JPY', is_enabled: false }]);
    await expect(service.resolve('JPY')).rejects.toThrow();
  });

  it('never assumes a 2-digit minor-unit precision — a currency registered with a different exponent resolves as declared', async () => {
    const { service } = buildService([{ ...egp, code: 'KWD', minor_unit_exponent: 3 }]);
    const resolved = await service.resolve('KWD');
    expect(resolved.minor_unit_exponent).toBe(3);
  });

  it('lists only enabled currencies', async () => {
    const { service } = buildService([egp, { ...egp, code: 'XXX', is_enabled: false }]);
    const list = await service.listEnabled();
    expect(list.map((c) => c.code)).toEqual(['EGP']);
  });

  describe('assertPriceInBounds', () => {
    it('always exempts a zero price regardless of the registered minimum', async () => {
      const { service } = buildService([egp]);
      await expect(service.assertPriceInBounds('EGP', 0)).resolves.toBeUndefined();
    });

    it('rejects a price below the registered minimum', async () => {
      const { service } = buildService([egp]);
      await expect(service.assertPriceInBounds('EGP', 100)).rejects.toThrow();
    });

    it('rejects a price above the registered maximum', async () => {
      const { service } = buildService([egp]);
      await expect(service.assertPriceInBounds('EGP', 3_000_000)).rejects.toThrow();
    });

    it('accepts a price within bounds', async () => {
      const { service } = buildService([egp]);
      await expect(service.assertPriceInBounds('EGP', 10_000)).resolves.toBeUndefined();
    });
  });
});
