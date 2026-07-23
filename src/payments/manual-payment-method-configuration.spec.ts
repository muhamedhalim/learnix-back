import { ManualPaymentMethodType } from './entities/manual-payment-method-type.enum';
import {
  normalizeManualPaymentConfiguration,
  serializeManualPaymentMethodForStudent,
} from './manual-payment-method-configuration';
import { ManualPaymentsService } from './services/manual-payments.service';

describe('manual payment method configuration', () => {
  it.each([
    [
      ManualPaymentMethodType.BANK_TRANSFER,
      { bank_name: 'CIB', account_number: '1234-5678', iban: 'EG380002000101234567890123456' },
    ],
    [
      ManualPaymentMethodType.INSTAPAY,
      { instapay_address: 'learnix@instapay', phone_number: '+201001234567' },
    ],
    [
      ManualPaymentMethodType.MOBILE_WALLET,
      { provider: 'Vodafone Cash', phone_number: '01001234567', wallet_holder_name: 'أحمد Smith' },
    ],
    [
      ManualPaymentMethodType.CASH,
      { location_name: 'Cairo office', address: '12 شارع التحرير', working_hours: '10:00-18:00' },
    ],
    [ManualPaymentMethodType.CUSTOM, { label: 'Reference', value: 'ABC-123' }],
  ])('accepts a valid %s configuration', (type, configuration) => {
    expect(normalizeManualPaymentConfiguration(type, configuration)).toEqual(configuration);
  });

  it.each([
    [{ bank_name: 'CIB', account_number: 'x' }, 'Account number is invalid'],
    [{ bank_name: 'CIB', account_number: '1234', iban: 'not-an-iban' }, 'IBAN is invalid'],
  ])('rejects invalid bank data', (configuration, message) => {
    expect(() =>
      normalizeManualPaymentConfiguration(ManualPaymentMethodType.BANK_TRANSFER, configuration),
    ).toThrow(message);
  });

  it('serializes only the active-checkout fields and no legacy/internal destination data', () => {
    const response = serializeManualPaymentMethodForStudent({
      id: 'method-1',
      name: 'تحويل Bank',
      type: ManualPaymentMethodType.BANK_TRANSFER,
      recipient_name: 'Recipient',
      configuration: { bank_name: 'CIB', account_number: '1234' },
      instructions: 'ادفع إلى الحساب Pay exactly.',
      qr_file_key: null,
      proof_required: true,
      transaction_reference_required: true,
      destination_details: { secret: 'legacy' },
      internal_notes: 'do not expose',
      name_ar: 'Legacy',
      instructions_ar: 'Legacy instructions',
      legacy_content_metadata: { legacy_name_ar: 'Legacy' },
    } as never);
    expect(response).toEqual(
      expect.objectContaining({ name: 'تحويل Bank', instructions: 'ادفع إلى الحساب Pay exactly.' }),
    );
    expect(response).not.toHaveProperty('destination_details');
    expect(response).not.toHaveProperty('internal_notes');
    expect(response).not.toHaveProperty('name_ar');
  });

  it('enforces integer minor-unit limit ordering in the backend service', () => {
    const service = ManualPaymentsService.prototype as unknown as {
      assertMethodLimits: (minimum?: number | null, maximum?: number | null) => void;
    };
    expect(() => service.assertMethodLimits(201, 200)).toThrow(
      'Minimum amount cannot exceed maximum amount',
    );
    expect(() => service.assertMethodLimits(200, 200)).not.toThrow();
  });
});
