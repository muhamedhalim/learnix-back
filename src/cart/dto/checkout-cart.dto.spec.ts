import { PaymentMethod } from '../../payments/entities/payment-method.enum';
import { CheckoutCartDto } from './checkout-cart.dto';

describe('CheckoutCartDto', () => {
  it('uses the canonical hosted-gateway card method and has no cart activation-code field', () => {
    const dto = new CheckoutCartDto();
    dto.payment_method = PaymentMethod.CARD;

    expect(dto.payment_method).toBe('card');
    expect('attendanceCode' in dto).toBe(false);
  });
});
