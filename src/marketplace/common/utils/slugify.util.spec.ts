import { slugify } from './slugify.util';

describe('slugify', () => {
  it('lowercases, hyphenates, and appends a random suffix', () => {
    const result = slugify('Nour Ahmed', 'instructor');
    expect(result).toMatch(/^nour-ahmed-[0-9a-f]{6}$/);
  });

  it('supports Arabic text', () => {
    const result = slugify('البرمجة', 'category');
    expect(result).toMatch(/^البرمجة-[0-9a-f]{6}$/);
  });

  it('falls back to the given word when the input has no usable characters', () => {
    const result = slugify('!!!', 'course');
    expect(result).toMatch(/^course-[0-9a-f]{6}$/);
  });

  it('produces a different suffix on every call', () => {
    const a = slugify('Same Title', 'x');
    const b = slugify('Same Title', 'x');
    expect(a).not.toBe(b);
  });
});
