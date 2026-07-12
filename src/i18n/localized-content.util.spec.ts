import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { pickLocalized, pickLocalizedArray, resolveLocale } from './localized-content.util';

describe('localized-content.util', () => {
  const row = {
    title: 'Algebra',
    title_ar: 'الجبر',
    description: 'Intro',
    description_ar: null as string | null,
    requirements: ['Calculator', 'Notebook'],
    requirements_ar: ['آلة حاسبة'] as string[] | null,
  };

  describe('pickLocalized', () => {
    it('returns English for EN locale', () => {
      expect(pickLocalized(row, 'title', PreferredLanguage.EN)).toBe('Algebra');
    });

    it('returns Arabic for AR locale when present', () => {
      expect(pickLocalized(row, 'title', PreferredLanguage.AR)).toBe('الجبر');
    });

    it('falls back to English when Arabic is null', () => {
      expect(pickLocalized(row, 'description', PreferredLanguage.AR)).toBe('Intro');
    });

    it('treats null/undefined locale as English', () => {
      expect(pickLocalized(row, 'title', null)).toBe('Algebra');
      expect(pickLocalized(row, 'title', undefined)).toBe('Algebra');
    });
  });

  describe('pickLocalizedArray', () => {
    it('returns the Arabic array when present for AR', () => {
      expect(pickLocalizedArray(row, 'requirements', PreferredLanguage.AR)).toEqual(['آلة حاسبة']);
    });

    it('falls back to English array when Arabic is empty', () => {
      const r = { requirements: ['A'], requirements_ar: [] as string[] };
      expect(pickLocalizedArray(r, 'requirements', PreferredLanguage.AR)).toEqual(['A']);
    });

    it('returns English array for EN', () => {
      expect(pickLocalizedArray(row, 'requirements', PreferredLanguage.EN)).toEqual([
        'Calculator',
        'Notebook',
      ]);
    });
  });

  describe('resolveLocale', () => {
    it('maps null to English', () => {
      expect(resolveLocale(null)).toBe(PreferredLanguage.EN);
    });
    it('preserves Arabic', () => {
      expect(resolveLocale(PreferredLanguage.AR)).toBe(PreferredLanguage.AR);
    });
  });
});
