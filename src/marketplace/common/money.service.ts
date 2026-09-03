import { BadRequestException, Injectable } from '@nestjs/common';

import { biBody } from '../../i18n/error-translator.util';
import { CurrencyRegistryService } from './currency-registry.service';

/**
 * Per-currency arithmetic helpers for the marketplace. Precision always
 * comes from the currency registry, never assumed. Every marketplace
 * calculation is integer minor units — no floating point (FR-326).
 */
@Injectable()
export class MarketplaceMoneyService {
  constructor(private readonly currencyRegistry: CurrencyRegistryService) {}

  /** Refuses to combine amounts across two different currencies (FR-127). */
  public assertSameCurrency(a: string, b: string): void {
    if (a !== b) {
      throw new BadRequestException(
        biBody(
          `Cannot combine amounts in ${a} and ${b} — the marketplace never converts currency`,
          `لا يمكن جمع مبالغ بعملتي ${a} و${b} — المنصة لا تحول العملات أبدًا`,
        ),
      );
    }
  }

  public add(a: { amountMinor: number; currency: string }, b: { amountMinor: number; currency: string }): number {
    this.assertSameCurrency(a.currency, b.currency);
    return a.amountMinor + b.amountMinor;
  }

  public subtract(
    a: { amountMinor: number; currency: string },
    b: { amountMinor: number; currency: string },
  ): number {
    this.assertSameCurrency(a.currency, b.currency);
    return a.amountMinor - b.amountMinor;
  }

  /**
   * FR-137: `commission = floor(capturedMinor * rateBps / 10000)`, and the
   * residue always accrues to the instructor. Rounding itself needs no
   * currency-specific behaviour (integer floor division is exact for any
   * exponent), but validating the currency is enabled goes through the
   * registry so an unknown or disabled currency can never be split.
   */
  public async splitCommission(
    capturedMinor: number,
    rateBps: number,
    currency: string,
  ): Promise<{ commissionMinor: number; instructorEarningMinor: number }> {
    await this.currencyRegistry.resolve(currency);
    if (!Number.isSafeInteger(capturedMinor) || capturedMinor < 0) {
      throw new BadRequestException(biBody('Invalid captured amount', 'قيمة محصّلة غير صالحة'));
    }
    if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
      throw new BadRequestException(
        biBody('Commission rate must be between 0 and 10000 basis points', 'يجب أن تكون نسبة العمولة بين 0 و10000 نقطة أساس'),
      );
    }
    const commissionMinor = Math.floor((capturedMinor * rateBps) / 10_000);
    return { commissionMinor, instructorEarningMinor: capturedMinor - commissionMinor };
  }
}
