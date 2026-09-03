import { getMetadataArgsStorage } from 'typeorm';

import { InstructorEarning } from './instructor-earning.entity';
import { MarketplaceCommissionSetting } from './marketplace-commission-setting.entity';
import { MarketplaceCurrency } from './marketplace-currency.entity';
import { MarketplaceLedgerEntry } from './marketplace-ledger-entry.entity';

function columnNames(target: unknown): string[] {
  return getMetadataArgsStorage()
    .columns.filter((c) => c.target === target)
    .map((c) => c.propertyName);
}

describe('MarketplaceCurrency entity (FR-325)', () => {
  it('is keyed by ISO code and carries precision + bounds', () => {
    const names = columnNames(MarketplaceCurrency);
    expect(names).toEqual(
      expect.arrayContaining([
        'code',
        'minor_unit_exponent',
        'is_enabled',
        'min_price_minor',
        'max_price_minor',
        'min_payout_minor',
      ]),
    );
    const checkNames = getMetadataArgsStorage()
      .checks.filter((c) => c.target === MarketplaceCurrency)
      .map((c) => c.name);
    expect(checkNames).toContain('CHK_mp_currencies_bounds');
    expect(checkNames).toContain('CHK_mp_currencies_exponent');
  });
});

describe('MarketplaceCommissionSetting entity', () => {
  it('is append-only history with a bounded rate (FR-136)', () => {
    const names = columnNames(MarketplaceCommissionSetting);
    expect(names).toEqual(expect.arrayContaining(['scope', 'rate_bps', 'effective_from', 'superseded_at']));
    const check = getMetadataArgsStorage().checks.find(
      (c) => c.target === MarketplaceCommissionSetting && c.name === 'CHK_mp_commission_rate_range',
    );
    expect(check).toBeDefined();
  });
});

describe('InstructorEarning entity', () => {
  it('has exactly one earning per order and reconciles gross = commission + net', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === InstructorEarning && i.name === 'UQ_mp_earnings_order',
    );
    expect(index?.unique).toBe(true);
    const check = getMetadataArgsStorage().checks.find(
      (c) => c.target === InstructorEarning && c.name === 'CHK_mp_earnings_split',
    );
    expect(check).toBeDefined();
  });
});

describe('MarketplaceLedgerEntry entity (FR-157 – FR-175)', () => {
  it('carries a unique reference for idempotency and no update timestamp column (immutable)', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceLedgerEntry && i.name === 'UQ_mp_ledger_reference',
    );
    expect(index?.unique).toBe(true);
    const names = columnNames(MarketplaceLedgerEntry);
    expect(names).not.toContain('updated_at');
  });

  it('requires actor and reason for a manual_adjustment entry (FR-168)', () => {
    const check = getMetadataArgsStorage().checks.find(
      (c) => c.target === MarketplaceLedgerEntry && c.name === 'CHK_mp_ledger_adjustment_reason',
    );
    expect(check).toBeDefined();
  });

  it('requires a positive amount and an explicit direction (FR-161)', () => {
    const checkNames = getMetadataArgsStorage()
      .checks.filter((c) => c.target === MarketplaceLedgerEntry)
      .map((c) => c.name);
    expect(checkNames).toContain('CHK_mp_ledger_amount_positive');
    expect(checkNames).toContain('CHK_mp_ledger_direction');
  });
});
