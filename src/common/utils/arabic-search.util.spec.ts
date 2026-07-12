import { normalizeArabicQuery } from './arabic-search.util';

describe('normalizeArabicQuery', () => {
  it('strips diacritics', () => {
    expect(normalizeArabicQuery('مُحَمَّد')).toBe('محمد');
  });

  it('folds hamza-bearing alef forms so both spellings match', () => {
    expect(normalizeArabicQuery('أحمد')).toBe(normalizeArabicQuery('احمد'));
    expect(normalizeArabicQuery('إسلام')).toBe(normalizeArabicQuery('اسلام'));
    expect(normalizeArabicQuery('آمنة')).toBe(normalizeArabicQuery('امنه'));
  });

  it('folds teh marbuta to heh', () => {
    expect(normalizeArabicQuery('مدرسة')).toBe('مدرسه');
  });

  it('folds alef maksura to yeh', () => {
    expect(normalizeArabicQuery('على')).toBe('علي');
  });

  it('strips tatweel', () => {
    expect(normalizeArabicQuery('محمـــد')).toBe('محمد');
  });

  it('collapses whitespace and trims', () => {
    expect(normalizeArabicQuery('  محمد   احمد  ')).toBe('محمد احمد');
  });

  it('leaves non-Arabic text unchanged', () => {
    expect(normalizeArabicQuery('Algorithms 101')).toBe('Algorithms 101');
  });
});
