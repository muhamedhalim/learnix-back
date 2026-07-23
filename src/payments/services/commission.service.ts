import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { biBody } from '../../i18n/error-translator.util';

export interface CommissionBreakdown {
  platformCommissionBps: number;
  platformCommissionMinor: number;
  teacherEarningMinor: number;
}

@Injectable()
export class CommissionService {
  private readonly defaultPlatformCommissionBps: number;

  constructor(config: ConfigService) {
    this.defaultPlatformCommissionBps = Number.parseInt(
      config.get<string>('DEFAULT_PLATFORM_COMMISSION_BPS') ?? '3000',
      10,
    );
    this.assertRate(this.defaultPlatformCommissionBps);
  }

  public resolveRate(snapshotOverride?: number | null): number {
    const rate = snapshotOverride ?? this.defaultPlatformCommissionBps;
    this.assertRate(rate);
    return rate;
  }

  public calculate(netPaidMinor: number, snapshotOverride?: number | null): CommissionBreakdown {
    if (!Number.isSafeInteger(netPaidMinor) || netPaidMinor < 0) {
      throw new BadRequestException(biBody('Invalid order amount', 'قيمة الطلب غير صالحة'));
    }
    const platformCommissionBps = this.resolveRate(snapshotOverride);
    // Platform commission rounds down to the minor unit; the residual belongs
    // to the teacher, guaranteeing exact conservation of the paid amount.
    const platformCommissionMinor = Math.floor((netPaidMinor * platformCommissionBps) / 10_000);
    return {
      platformCommissionBps,
      platformCommissionMinor,
      teacherEarningMinor: netPaidMinor - platformCommissionMinor,
    };
  }

  private assertRate(rate: number): void {
    if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) {
      throw new BadRequestException(
        biBody(
          'Platform commission must be between 0 and 10000 basis points',
          'يجب أن تكون عمولة المنصة بين 0 و10000 نقطة أساس',
        ),
      );
    }
  }
}
