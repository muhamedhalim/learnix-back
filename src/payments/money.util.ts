import { BadRequestException } from '@nestjs/common';

import { biBody } from '../i18n/error-translator.util';

export const EGP_CURRENCY = 'EGP';

/**
 * Converts a database/product major-unit amount to integer minor units.
 * Decimal columns are returned by pg as strings in some query paths, so the
 * boundary accepts strings but rejects anything that is not a finite amount
 * with at most two decimal places.
 */
export function toMinorUnits(value: number | string): number {
  const normalized = typeof value === 'string' ? value.trim() : String(value);
  if (!/^-?\d+(?:\.\d{1,2})?$/u.test(normalized)) {
    throw new BadRequestException(biBody('Invalid monetary amount', 'قيمة مالية غير صالحة'));
  }
  const [whole, fraction = ''] = normalized.split('.');
  const sign = whole?.startsWith('-') ? -1 : 1;
  const absoluteWhole = (whole ?? '0').replace('-', '');
  const minor =
    Number.parseInt(absoluteWhole, 10) * 100 + Number.parseInt(fraction.padEnd(2, '0'), 10);
  if (!Number.isSafeInteger(minor)) {
    throw new BadRequestException(
      biBody('Monetary amount is too large', 'القيمة المالية أكبر من الحد المسموح'),
    );
  }
  return minor * sign;
}

export function fromMinorUnits(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError('Minor-unit amount must be a safe integer');
  }
  return value / 100;
}

export const minorUnitsTransformer = {
  to(value: number | null | undefined): number | null | undefined {
    return value;
  },
  from(value: string | number | null): number | null {
    if (value === null) return null;
    const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new TypeError('Database money value exceeds JavaScript safe-integer range');
    }
    return parsed;
  },
};
