import { ManualPaymentMethodType } from './entities/manual-payment-method-type.enum';
import type { ManualPaymentMethod } from './entities/manual-payment-method.entity';

export type ManualPaymentConfiguration = Record<string, string>;

const requiredFields: Record<ManualPaymentMethodType, readonly string[]> = {
  [ManualPaymentMethodType.BANK_TRANSFER]: ['bank_name', 'account_number'],
  [ManualPaymentMethodType.INSTAPAY]: ['instapay_address'],
  [ManualPaymentMethodType.MOBILE_WALLET]: ['provider', 'phone_number', 'wallet_holder_name'],
  [ManualPaymentMethodType.CASH]: ['location_name', 'address'],
  [ManualPaymentMethodType.CUSTOM]: ['label', 'value'],
};

const allowedFields: Record<ManualPaymentMethodType, readonly string[]> = {
  [ManualPaymentMethodType.BANK_TRANSFER]: [
    'bank_name',
    'branch_name',
    'account_number',
    'iban',
    'swift_code',
  ],
  [ManualPaymentMethodType.INSTAPAY]: ['instapay_address', 'phone_number'],
  [ManualPaymentMethodType.MOBILE_WALLET]: ['provider', 'phone_number', 'wallet_holder_name'],
  [ManualPaymentMethodType.CASH]: ['location_name', 'address', 'working_hours'],
  [ManualPaymentMethodType.CUSTOM]: ['label', 'value'],
};

const ibanPattern = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const swiftPattern = /^[A-Z0-9]{8}(?:[A-Z0-9]{3})?$/;
const phonePattern = /^\+?[0-9][0-9\s()-]{6,24}$/;
const accountPattern = /^[A-Z0-9][A-Z0-9\s-]{3,33}$/i;

export function normalizeManualPaymentConfiguration(
  type: ManualPaymentMethodType,
  value: Record<string, unknown>,
): ManualPaymentConfiguration {
  const allowed = new Set(allowedFields[type]);
  const normalized: ManualPaymentConfiguration = {};
  for (const [key, rawValue] of Object.entries(value ?? {})) {
    if (!allowed.has(key)) continue;
    if (typeof rawValue !== 'string') {
      throw new Error(`Configuration field ${key} must be a string`);
    }
    const trimmed = rawValue.trim();
    if (trimmed) normalized[key] = trimmed;
  }

  for (const field of requiredFields[type]) {
    if (!normalized[field]) throw new Error(`Configuration field ${field} is required`);
  }
  if (Object.values(normalized).some((field) => field.length > 500)) {
    throw new Error('Configuration values must be 500 characters or fewer');
  }
  if (
    normalized['iban'] &&
    !ibanPattern.test(normalized['iban'].replaceAll(' ', '').toUpperCase())
  ) {
    throw new Error('IBAN is invalid');
  }
  if (normalized['swift_code'] && !swiftPattern.test(normalized['swift_code'].toUpperCase())) {
    throw new Error('SWIFT code is invalid');
  }
  if (normalized['account_number'] && !accountPattern.test(normalized['account_number'])) {
    throw new Error('Account number is invalid');
  }
  if (normalized['phone_number'] && !phonePattern.test(normalized['phone_number'])) {
    throw new Error('Phone number is invalid');
  }
  return normalized;
}

export function studentManualPaymentConfiguration(
  type: ManualPaymentMethodType,
  configuration: ManualPaymentConfiguration,
): ManualPaymentConfiguration {
  const permitted = new Set(allowedFields[type]);
  return Object.fromEntries(
    Object.entries(configuration ?? {}).filter(
      ([key, value]) => permitted.has(key) && typeof value === 'string',
    ),
  ) as ManualPaymentConfiguration;
}

export function serializeManualPaymentMethodForStudent(method: ManualPaymentMethod): {
  id: string;
  name: string;
  type: ManualPaymentMethodType;
  recipient_name: string;
  configuration: ManualPaymentConfiguration;
  instructions: string;
  qr_available: boolean;
  proof_required: boolean;
  transaction_reference_required: boolean;
} {
  return {
    id: method.id,
    name: method.name,
    type: method.type,
    recipient_name: method.recipient_name,
    configuration: studentManualPaymentConfiguration(method.type, method.configuration),
    instructions: method.instructions,
    qr_available: method.qr_file_key !== null,
    proof_required: method.proof_required,
    transaction_reference_required: method.transaction_reference_required,
  };
}
