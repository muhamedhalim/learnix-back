import { Injectable, NotFoundException } from '@nestjs/common';

import { biBody } from '../../i18n/error-translator.util';
import type { PaymentProvider } from '../providers/payment-provider.interface';
import { EasyKashService } from './easykash.service';

@Injectable()
export class PaymentProviderRegistry {
  private readonly providers: ReadonlyMap<string, PaymentProvider>;

  constructor(easyKash: EasyKashService) {
    this.providers = new Map([[easyKash.name, easyKash]]);
  }

  public get(name?: string | null): PaymentProvider {
    const providerName = name ?? 'easykash';
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new NotFoundException(
        biBody('Payment provider is not available', 'مزود الدفع غير متاح'),
      );
    }
    return provider;
  }

  public list(): Array<{
    name: string;
    supportsRefunds: boolean;
    supportsPayouts: boolean;
    supportsSplitSettlement: boolean;
  }> {
    return [...this.providers.values()].map((provider) => ({
      name: provider.name,
      supportsRefunds: provider.supportsRefunds(),
      supportsPayouts: provider.supportsPayouts(),
      supportsSplitSettlement: provider.supportsSplitSettlement(),
    }));
  }
}
