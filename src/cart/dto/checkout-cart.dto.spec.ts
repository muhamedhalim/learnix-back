import { PaymentMethod } from './checkout-cart.dto';

describe('CheckoutCartDto payment methods', () => {
  it('accepts Paymob as the online payment method', () => {
    expect(PaymentMethod.PAYMOB).toBe('paymob');
    expect(Object.values(PaymentMethod)).toEqual(['paymob', 'attendance_code']);
  });
});
