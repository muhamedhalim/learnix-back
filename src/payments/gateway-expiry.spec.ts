import { gatewayOrderExpirationMinutes } from './gateway-expiry';

describe('gatewayOrderExpirationMinutes', () => {
  it('keeps the historical 60 minutes when EasyKash is not configured', () => {
    expect(gatewayOrderExpirationMinutes({})).toBe(60);
  });

  it('outlives the cash voucher plus a callback grace margin', () => {
    expect(
      gatewayOrderExpirationMinutes({ EASYKASH_API_KEY: 'k', EASYKASH_CASH_EXPIRY_HOURS: '24' }),
    ).toBe(24 * 60 + 15);
  });

  it('defaults to a 24 hour voucher and ignores invalid values', () => {
    expect(gatewayOrderExpirationMinutes({ EASYKASH_API_KEY: 'k' })).toBe(24 * 60 + 15);
    expect(
      gatewayOrderExpirationMinutes({ EASYKASH_API_KEY: 'k', EASYKASH_CASH_EXPIRY_HOURS: '500' }),
    ).toBe(24 * 60 + 15);
  });
});
