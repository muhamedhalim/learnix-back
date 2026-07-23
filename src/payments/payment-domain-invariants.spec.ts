import { BadRequestException } from '@nestjs/common';

import {
  hashAttendanceCode,
  normalizeAttendanceCode,
} from '../attendance-codes/code-generator.util';
import { fromMinorUnits, toMinorUnits } from './money.util';

describe('unified payment domain invariants', () => {
  describe('minor-unit money boundaries', () => {
    it.each([
      ['0', 0],
      ['1', 100],
      ['1.2', 120],
      ['1.23', 123],
      [99.99, 9999],
    ])('converts %p without binary floating-point arithmetic', (input, expected) => {
      expect(toMinorUnits(input)).toBe(expected);
      expect(fromMinorUnits(expected)).toBe(expected / 100);
    });

    it.each(['1.234', 'NaN', '1e3', '', '12,00'])('rejects unsafe amount %p', (input) => {
      expect(() => toMinorUnits(input)).toThrow(BadRequestException);
    });
  });

  describe('activation-code lookup privacy', () => {
    it('normalizes formatting before producing a deterministic SHA-256 lookup', () => {
      expect(normalizeAttendanceCode(' ab12-cd34 ')).toBe('AB12CD34');
      expect(hashAttendanceCode('ab12-cd34')).toBe(hashAttendanceCode(' AB12 CD34 '));
      expect(hashAttendanceCode('AB12CD34')).toMatch(/^[a-f0-9]{64}$/u);
    });

    it('does not return the raw activation code as the lookup value', () => {
      expect(hashAttendanceCode('AB12CD34')).not.toContain('AB12CD34');
    });
  });
});
