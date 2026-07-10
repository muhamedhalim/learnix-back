import { InvalidPhoneNumberError, isE164, isEgyptianMobile, toE164, toE164OrThrow } from './phone.util';

describe('phone.util', () => {
  describe('toE164', () => {
    it.each([
      ['01012345678', '+201012345678'],
      ['01112345678', '+201112345678'],
      ['01212345678', '+201212345678'],
      ['01512345678', '+201512345678'],
    ])('normalises Egyptian national %s → %s', (input, expected) => {
      expect(toE164(input)).toBe(expected);
    });

    it('accepts the international form with and without a plus', () => {
      expect(toE164('201012345678')).toBe('+201012345678');
      expect(toE164('+201012345678')).toBe('+201012345678');
    });

    it('is insensitive to separators and surrounding whitespace', () => {
      expect(toE164(' 010-1234 5678 ')).toBe('+201012345678');
      expect(toE164('(010) 1234-5678')).toBe('+201012345678');
    });

    it('normalises Arabic-Indic digits', () => {
      expect(toE164('٠١٠١٢٣٤٥٦٧٨')).toBe('+201012345678');
    });

    it('collapses every spelling of one number to a single canonical string', () => {
      const spellings = ['01012345678', '201012345678', '+201012345678', '+20 101 234 5678'];
      const canonical = new Set(spellings.map((s) => toE164(s)));
      expect(canonical).toEqual(new Set(['+201012345678']));
    });

    it('rejects the comma that the old register regex allowed', () => {
      // /^01[0-2,5]\d{8}$/ matched a literal comma — see the audit.
      expect(toE164('01,12345678')).toBeNull();
    });

    it.each([
      ['013 is not an Egyptian mobile prefix', '01312345678'],
      ['too short', '0101234567'],
      ['too long', '010123456789'],
      ['letters', '010ABCD5678'],
      ['empty', ''],
      ['leading zero after plus', '+0201012345678'],
    ])('rejects %s', (_label, input) => {
      expect(toE164(input)).toBeNull();
    });

    it('returns null for null/undefined', () => {
      expect(toE164(null)).toBeNull();
      expect(toE164(undefined)).toBeNull();
    });

    it('passes through valid non-Egyptian E.164 untouched', () => {
      expect(toE164('+14155552671')).toBe('+14155552671');
      expect(toE164('+442071838750')).toBe('+442071838750');
    });

    it('does not guess a country for a bare foreign national number', () => {
      expect(toE164('4155552671')).toBeNull();
    });
  });

  describe('toE164OrThrow', () => {
    it('returns the canonical form', () => {
      expect(toE164OrThrow('01012345678')).toBe('+201012345678');
    });

    it('throws without leaking the offending number', () => {
      expect(() => toE164OrThrow('bogus')).toThrow(InvalidPhoneNumberError);
      expect(() => toE164OrThrow('01312345678')).toThrow(/valid mobile number/);
      try {
        toE164OrThrow('01312345678');
      } catch (error) {
        expect((error as Error).message).not.toContain('01312345678');
      }
    });
  });

  describe('isE164 / isEgyptianMobile', () => {
    it('recognises canonical strings', () => {
      expect(isE164('+201012345678')).toBe(true);
      expect(isE164('01012345678')).toBe(false);
    });

    it('distinguishes Egyptian mobiles from other E.164 numbers', () => {
      expect(isEgyptianMobile('+201012345678')).toBe(true);
      expect(isEgyptianMobile('+14155552671')).toBe(false);
      expect(isEgyptianMobile('+20212345678')).toBe(false); // Cairo landline
    });
  });
});
