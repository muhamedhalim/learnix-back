import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CommissionService } from './commission.service';

describe('CommissionService', () => {
  const config = (value?: string) =>
    ({
      get: jest.fn().mockReturnValue(value),
    }) as unknown as ConfigService;

  it('uses the configured 30% platform rate and conserves every minor unit', () => {
    const service = new CommissionService(config('3000'));

    expect(service.calculate(10_001)).toEqual({
      platformCommissionBps: 3000,
      platformCommissionMinor: 3000,
      teacherEarningMinor: 7001,
    });
  });

  it('gives an immutable snapshot override precedence over the current default', () => {
    const service = new CommissionService(config('3000'));

    expect(service.calculate(12_345, 2500)).toEqual({
      platformCommissionBps: 2500,
      platformCommissionMinor: 3086,
      teacherEarningMinor: 9259,
    });
  });

  it('rejects floating-point minor units and invalid basis-point rates', () => {
    const service = new CommissionService(config('3000'));

    expect(() => service.calculate(10.5)).toThrow(BadRequestException);
    expect(() => service.calculate(100, 10_001)).toThrow(BadRequestException);
  });

  it('calculates a deterministic platform-paid gateway fee', () => {
    const service = new CommissionService(config('3000'));

    expect(service.calculateGatewayFee(10_001)).toEqual({
      gatewayFeeBps: 3000,
      gatewayFeeMinor: 3000,
    });
  });
});
