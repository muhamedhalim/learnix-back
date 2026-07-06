import { QuestionType } from '../entities';
import { QuestionTypeRegistry } from './question-type-registry';

describe('QuestionTypeRegistry — per-type grading', () => {
  const registry = new QuestionTypeRegistry();

  it('registers a definition for every QuestionType enum value', () => {
    for (const type of Object.values(QuestionType)) {
      expect(registry.has(type)).toBe(true);
    }
    expect(registry.list()).toHaveLength(Object.values(QuestionType).length);
  });

  describe('single_choice', () => {
    const key = { correctOptionId: 'b' };
    const def = registry.require(QuestionType.SINGLE_CHOICE);
    it('full marks for the correct option', () => {
      expect(def.grade({ optionId: 'b' }, key)).toEqual({
        fraction: 1,
        isCorrect: true,
        manualRequired: false,
      });
    });
    it('zero for a wrong option and for unanswered', () => {
      expect(def.grade({ optionId: 'a' }, key).fraction).toBe(0);
      expect(def.grade(null, key).fraction).toBe(0);
    });
  });

  describe('multiple_select (partial credit)', () => {
    const key = { correctOptionIds: ['a', 'b'] };
    const def = registry.require(QuestionType.MULTIPLE_SELECT);
    it('awards full credit for the exact set', () => {
      expect(def.grade({ optionIds: ['a', 'b'] }, key)).toEqual({
        fraction: 1,
        isCorrect: true,
        manualRequired: false,
      });
    });
    it('awards partial credit and never below zero', () => {
      expect(def.grade({ optionIds: ['a'] }, key).fraction).toBeCloseTo(0.5);
      // one correct, one wrong => (1-1)/2 = 0
      expect(def.grade({ optionIds: ['a', 'c'] }, key).fraction).toBe(0);
      // two wrong => clamped to 0
      expect(def.grade({ optionIds: ['c', 'd'] }, key).fraction).toBe(0);
      expect(def.grade({ optionIds: ['a'] }, key).isCorrect).toBe(false);
    });
  });

  describe('true_false', () => {
    const def = registry.require(QuestionType.TRUE_FALSE);
    it('grades boolean equality', () => {
      expect(def.grade({ value: true }, { value: true }).fraction).toBe(1);
      expect(def.grade({ value: false }, { value: true }).fraction).toBe(0);
    });
  });

  describe('fill_blank (normalized, partial)', () => {
    const key = {
      blanks: [
        { id: '1', accepted: ['Cairo'] },
        { id: '2', accepted: ['Nile'], caseSensitive: true },
      ],
    };
    const def = registry.require(QuestionType.FILL_BLANK);
    it('is case-insensitive by default and trims whitespace', () => {
      expect(
        def.grade({ blanks: [{ id: '1', value: '  cairo ' }, { id: '2', value: 'Nile' }] }, key)
          .fraction,
      ).toBe(1);
    });
    it('respects caseSensitive blanks and awards partial credit', () => {
      const r = def.grade({ blanks: [{ id: '1', value: 'cairo' }, { id: '2', value: 'nile' }] }, key);
      expect(r.fraction).toBeCloseTo(0.5);
      expect(r.isCorrect).toBe(false);
    });
  });

  describe('numeric (tolerance)', () => {
    const def = registry.require(QuestionType.NUMERIC);
    it('accepts within tolerance', () => {
      expect(def.grade({ value: 3.14 }, { value: 3.1, tolerance: 0.05 }).fraction).toBe(1);
      expect(def.grade({ value: 3.2 }, { value: 3.1, tolerance: 0.05 }).fraction).toBe(0);
    });
    it('requires exact match with no tolerance', () => {
      expect(def.grade({ value: 5 }, { value: 5 }).fraction).toBe(1);
    });
  });

  describe('essay (manual)', () => {
    const def = registry.require(QuestionType.ESSAY);
    it('always requires manual grading and never auto-scores', () => {
      expect(def.grade({ text: 'anything' }, {})).toEqual({
        fraction: null,
        isCorrect: null,
        manualRequired: true,
      });
    });
  });

  describe('authoring validation', () => {
    it('rejects a single_choice whose correct id is not an option', () => {
      const errors = registry
        .require(QuestionType.SINGLE_CHOICE)
        .validateAuthoring(
          { prompt: { en: 'Q' }, options: [{ id: 'a', text: { en: 'A' } }, { id: 'b', text: { en: 'B' } }] },
          { correctOptionId: 'z' },
        );
      expect(errors.length).toBeGreaterThan(0);
    });
    it('accepts a valid true_false', () => {
      expect(
        registry
          .require(QuestionType.TRUE_FALSE)
          .validateAuthoring({ prompt: { en: 'Q' } }, { value: true }),
      ).toEqual([]);
    });
  });
});
