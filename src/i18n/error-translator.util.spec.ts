import type { Request } from 'express';

import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import {
  bi,
  resolveRequestLocale,
  translateMessage,
  translateMessages,
} from './error-translator.util';

function requestWithAcceptLanguage(value: string | undefined): Request {
  return { headers: { 'accept-language': value } } as unknown as Request;
}

describe('error-translator.util', () => {
  describe('resolveRequestLocale', () => {
    it('resolves Arabic when Accept-Language starts with ar', () => {
      expect(resolveRequestLocale(requestWithAcceptLanguage('ar-EG,ar;q=0.9'))).toBe(
        PreferredLanguage.AR,
      );
    });

    it('resolves English for any non-Arabic or missing header', () => {
      expect(resolveRequestLocale(requestWithAcceptLanguage('en-US'))).toBe(PreferredLanguage.EN);
      expect(resolveRequestLocale(requestWithAcceptLanguage(undefined))).toBe(PreferredLanguage.EN);
    });
  });

  describe('bi + translateMessage (explicit bilingual messages)', () => {
    it('returns the English half for EN locale', () => {
      const msg = bi('Invalid credentials', 'بيانات الاعتماد غير صحيحة');
      expect(translateMessage(msg, PreferredLanguage.EN)).toBe('Invalid credentials');
    });

    it('returns the Arabic half for AR locale', () => {
      const msg = bi('Invalid credentials', 'بيانات الاعتماد غير صحيحة');
      expect(translateMessage(msg, PreferredLanguage.AR)).toBe('بيانات الاعتماد غير صحيحة');
    });
  });

  describe('translateMessage (class-validator default patterns)', () => {
    it('translates "should not be empty"', () => {
      expect(translateMessage('email should not be empty', PreferredLanguage.AR)).toBe(
        'يجب ألا يكون email فارغًا',
      );
    });

    it('translates "must be a string"', () => {
      expect(translateMessage('name must be a string', PreferredLanguage.AR)).toBe(
        'يجب أن يكون name نصًا',
      );
    });

    it('translates minLength with the captured number', () => {
      expect(
        translateMessage(
          'password must be longer than or equal to 8 characters',
          PreferredLanguage.AR,
        ),
      ).toBe('يجب ألا يقل طول password عن 8 حرفًا');
    });

    it('leaves English requests untouched', () => {
      expect(translateMessage('email should not be empty', PreferredLanguage.EN)).toBe(
        'email should not be empty',
      );
    });

    it('falls back to the original string when no pattern matches', () => {
      expect(translateMessage('some unrecognised message', PreferredLanguage.AR)).toBe(
        'some unrecognised message',
      );
    });
  });

  describe('translateMessages', () => {
    it('maps translateMessage over an array', () => {
      expect(
        translateMessages(
          ['email should not be empty', 'name must be a string'],
          PreferredLanguage.AR,
        ),
      ).toEqual(['يجب ألا يكون email فارغًا', 'يجب أن يكون name نصًا']);
    });
  });
});
