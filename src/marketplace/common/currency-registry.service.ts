import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceCurrency } from '../earnings/entities/marketplace-currency.entity';

/**
 * The only place a currency's precision, price bounds or payout floor is
 * resolved (FR-325). No marketplace service reads a default of "2" or
 * assumes a single currency — every one of them asks this service.
 */
@Injectable()
export class CurrencyRegistryService {
  constructor(
    @InjectRepository(MarketplaceCurrency)
    private readonly currencies: Repository<MarketplaceCurrency>,
  ) {}

  /** Throws if the code is unknown or disabled — never silently falls back to a default. */
  public async resolve(code: string): Promise<MarketplaceCurrency> {
    const currency = await this.currencies.findOne({ where: { code } });
    if (!currency || !currency.is_enabled) {
      throw new BadRequestException(
        biBody(`Currency ${code} is not enabled`, `العملة ${code} غير مفعّلة`),
      );
    }
    return currency;
  }

  public async listEnabled(): Promise<MarketplaceCurrency[]> {
    return this.currencies.find({ where: { is_enabled: true }, order: { code: 'ASC' } });
  }

  /** Rejects an amount outside the currency's configured course-price bounds. Zero is always exempt (FR-057). */
  public async assertPriceInBounds(code: string, priceMinor: number): Promise<void> {
    if (priceMinor === 0) return;
    const currency = await this.resolve(code);
    if (priceMinor < currency.min_price_minor || priceMinor > currency.max_price_minor) {
      throw new BadRequestException(
        biBody(
          `Price must be between ${currency.min_price_minor} and ${currency.max_price_minor} minor units of ${code}`,
          `يجب أن يكون السعر بين ${currency.min_price_minor} و${currency.max_price_minor} وحدة فرعية من ${code}`,
        ),
      );
    }
  }
}
