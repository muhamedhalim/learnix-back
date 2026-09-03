import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { getMarketplaceConfig } from '../../config/marketplace.config';
import { CommissionService, type CommissionBreakdown } from '../../payments/services/commission.service';
import { MarketplaceCommissionScope } from '../common/enums';
import { MarketplaceCommissionSetting } from './entities';

export interface CommissionResolution {
  rateBps: number;
  scope: MarketplaceCommissionScope;
  scopeRefId: string | null;
}

/**
 * FR-130 – FR-138, FR-326. Resolves the effective platform commission rate
 * and delegates every arithmetic step to the platform's existing
 * `CommissionService.calculate()` (`floor(net * bps / 10000)`, residual to
 * the instructor) rather than a second implementation. Only `PLATFORM`
 * scope is ever resolved today — `INSTRUCTOR`/`COURSE`/`CATEGORY` are
 * reserved on `MarketplaceCommissionScope` (data-model.md) but nothing
 * yet sets a rate at those scopes, so resolution only ever looks there and
 * finds nothing, falling through to platform-wide.
 */
@Injectable()
export class MarketplaceCommissionService {
  constructor(
    @InjectRepository(MarketplaceCommissionSetting)
    private readonly settings: Repository<MarketplaceCommissionSetting>,
    private readonly commission: CommissionService,
  ) {}

  /**
   * The current platform-wide rate, optionally narrowed to one currency.
   * Falls back through: a currency-specific row → an all-currencies
   * (`currency IS NULL`) row → the launch default (FR-132, §Y).
   */
  public async resolveEffectiveRate(currency?: string): Promise<CommissionResolution> {
    if (currency) {
      const scoped = await this.settings.findOne({
        where: { scope: MarketplaceCommissionScope.PLATFORM, currency, superseded_at: IsNull() },
        order: { effective_from: 'DESC' },
      });
      if (scoped) return { rateBps: scoped.rate_bps, scope: scoped.scope, scopeRefId: scoped.scope_ref_id };
    }
    const general = await this.settings.findOne({
      where: { scope: MarketplaceCommissionScope.PLATFORM, currency: IsNull(), superseded_at: IsNull() },
      order: { effective_from: 'DESC' },
    });
    if (general) return { rateBps: general.rate_bps, scope: general.scope, scopeRefId: general.scope_ref_id };

    return { rateBps: getMarketplaceConfig().commissionRateBps, scope: MarketplaceCommissionScope.PLATFORM, scopeRefId: null };
  }

  /** Delegates the actual split to the shared `CommissionService` — this class never computes the arithmetic itself. */
  public calculate(netMinor: number, rateBps: number): CommissionBreakdown {
    return this.commission.calculate(netMinor, rateBps);
  }

  /**
   * FR-136: an append-only history — a rate change inserts a new row and
   * stamps `superseded_at` on whichever row was previously effective for
   * the same (scope, scopeRefId, currency), rather than updating it in
   * place. Orders already placed keep their own `commission_bps` snapshot
   * (FR-134) regardless of later changes here.
   */
  public async setRate(input: {
    scope: MarketplaceCommissionScope;
    scopeRefId?: string | null;
    currency?: string | null;
    rateBps: number;
    createdBy: string;
  }): Promise<MarketplaceCommissionSetting> {
    const scopeRefId = input.scopeRefId ?? null;
    const currency = input.currency ?? null;
    const now = new Date();

    const previous = await this.settings.findOne({
      where: { scope: input.scope, scope_ref_id: scopeRefId ?? IsNull(), currency: currency ?? IsNull(), superseded_at: IsNull() },
      order: { effective_from: 'DESC' },
    });
    if (previous) {
      previous.superseded_at = now;
      await this.settings.save(previous);
    }

    const next = this.settings.create({
      scope: input.scope,
      scope_ref_id: scopeRefId,
      currency,
      rate_bps: input.rateBps,
      effective_from: now,
      created_by: input.createdBy,
    });
    return this.settings.save(next);
  }

  /** FR-285 (T190): full change history, newest first — every row `setRate()` has ever written, superseded or not. */
  public async getHistory(): Promise<MarketplaceCommissionSetting[]> {
    return this.settings.find({ order: { effective_from: 'DESC' } });
  }
}
