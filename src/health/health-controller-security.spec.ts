import { THROTTLE } from '../common/constants';
import { HealthController } from './health.controller';

describe('HealthController security metadata', () => {
  it('requires the admin role for detailed diagnostics', () => {
    const roles = Reflect.getMetadata('roles', HealthController.prototype.dashboard) as string[];
    expect(roles).toEqual(['admin']);
  });

  it('rate limits manual full checks', () => {
    const limit = Reflect.getMetadata(
      'THROTTLER:LIMITdefault',
      HealthController.prototype.runFull,
    ) as number;
    expect(limit).toBe(THROTTLE.STRICT.limit);
  });
});
