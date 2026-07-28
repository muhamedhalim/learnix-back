import { AdminDiscountCodesController } from './admin-discount-codes.controller';

describe('AdminDiscountCodesController permissions', () => {
  it('restricts discount-code administration to the admin role in backend metadata', () => {
    expect(Reflect.getMetadata('roles', AdminDiscountCodesController)).toEqual(['admin']);
  });
});
