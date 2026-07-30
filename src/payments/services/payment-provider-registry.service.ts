import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { biBody } from '../../i18n/error-translator.util';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../providers/payment-gateway.interface';

@Injectable()
export class PaymentProviderRegistry {
  private readonly providers: ReadonlyMap<string, PaymentGateway>;

  constructor(@Inject(PAYMENT_GATEWAY) private readonly defaultGateway: PaymentGateway) {
    this.providers = new Map([[defaultGateway.name, defaultGateway]]);
  }

  public get(name?: string | null): PaymentGateway {
    const providerName = name ?? this.defaultGateway.name;
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new NotFoundException(
        biBody('Payment provider is not available', 'مزود الدفع غير متاح'),
      );
    }
    return provider;
  }

  public getDefault(): PaymentGateway {
    return this.defaultGateway;
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
