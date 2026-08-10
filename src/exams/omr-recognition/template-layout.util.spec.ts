import type { ExamQuestion } from '../entities/exam-question.entity';
import { QuestionType } from '../entities/question-type.enum';
import {
  computeOmrContentHash,
  generateOmrTemplateLayout,
  maxQuestionsPerTemplate,
  OmrLayoutError,
} from './template-layout.util';
import { MAX_OPTIONS_PER_QUESTION } from './constants';

function eq(overrides: Partial<ExamQuestion>): ExamQuestion {
  return {
    id: 'q',
    order_index: 0,
    type_snapshot: QuestionType.SINGLE_CHOICE,
    content_snapshot: {
      prompt: { en: 'p' },
      options: [
        { id: 'a', text: { en: 'A' } },
        { id: 'b', text: { en: 'B' } },
      ],
    },
    ...overrides,
  } as unknown as ExamQuestion;
}

describe('generateOmrTemplateLayout', () => {
  it('lays out single_choice/multiple_select bubbles from content_snapshot.options in array order', () => {
    const questions = [
      eq({
        id: 'q1',
        order_index: 0,
        type_snapshot: QuestionType.SINGLE_CHOICE,
        content_snapshot: {
          options: [
            { id: 'opt_x', text: { en: 'X' } },
            { id: 'opt_y', text: { en: 'Y' } },
            { id: 'opt_z', text: { en: 'Z' } },
          ],
        },
      }),
    ];
    const layout = generateOmrTemplateLayout(questions);
    expect(layout.questions).toHaveLength(1);
    const bubbles = layout.questions[0]!.bubbles;
    expect(bubbles.map((b) => (b.kind === 'option' ? b.optionId : null))).toEqual([
      'opt_x',
      'opt_y',
      'opt_z',
    ]);
  });

  it('gives true_false a fixed 2-bubble boolean layout (no options array involved)', () => {
    const questions = [
      eq({
        id: 'q1',
        type_snapshot: QuestionType.TRUE_FALSE,
        content_snapshot: { prompt: { en: 'p' } },
      }),
    ];
    const layout = generateOmrTemplateLayout(questions);
    const bubbles = layout.questions[0]!.bubbles;
    expect(bubbles).toHaveLength(2);
    expect(bubbles.every((b) => b.kind === 'boolean')).toBe(true);
    expect(bubbles.map((b) => (b.kind === 'boolean' ? b.value : null))).toEqual([true, false]);
  });

  it('numbers printed labels by position among ALL questions, skipping essay rows without renumbering', () => {
    const questions = [
      eq({ id: 'q1', order_index: 0, type_snapshot: QuestionType.SINGLE_CHOICE }),
      eq({
        id: 'q2',
        order_index: 1,
        type_snapshot: QuestionType.ESSAY,
        content_snapshot: { prompt: { en: 'essay' } },
      }),
      eq({ id: 'q3', order_index: 2, type_snapshot: QuestionType.SINGLE_CHOICE }),
    ];
    const layout = generateOmrTemplateLayout(questions);
    expect(layout.questions.map((q) => ({ id: q.examQuestionId, label: q.label }))).toEqual([
      { id: 'q1', label: 1 },
      { id: 'q3', label: 3 },
    ]);
  });

  it('places every bubble within the printable page bounds', () => {
    const questions = Array.from({ length: 5 }, (_, i) =>
      eq({ id: `q${String(i)}`, order_index: i }),
    );
    const layout = generateOmrTemplateLayout(questions);
    for (const q of layout.questions) {
      for (const b of q.bubbles) {
        expect(b.x).toBeGreaterThan(0);
        expect(b.x).toBeLessThan(layout.pageWidthMm);
        expect(b.y).toBeGreaterThan(0);
        expect(b.y).toBeLessThan(layout.pageHeightMm);
      }
    }
  });

  it('throws when the exam has any numeric or fill_blank question (no manual-grading fallback exists for them)', () => {
    const questions = [
      eq({ id: 'q1', type_snapshot: QuestionType.SINGLE_CHOICE }),
      eq({
        id: 'q2',
        type_snapshot: QuestionType.NUMERIC,
        content_snapshot: { prompt: { en: 'n' } },
      }),
    ];
    expect(() => generateOmrTemplateLayout(questions)).toThrow(OmrLayoutError);
  });

  it('throws when the exam has no OMR-eligible questions at all', () => {
    const questions = [
      eq({
        id: 'q1',
        type_snapshot: QuestionType.ESSAY,
        content_snapshot: { prompt: { en: 'e' } },
      }),
    ];
    expect(() => generateOmrTemplateLayout(questions)).toThrow(OmrLayoutError);
  });

  it('throws when the eligible question count exceeds the single-page capacity', () => {
    const capacity = maxQuestionsPerTemplate();
    const questions = Array.from({ length: capacity + 1 }, (_, i) =>
      eq({ id: `q${String(i)}`, order_index: i }),
    );
    expect(() => generateOmrTemplateLayout(questions)).toThrow(OmrLayoutError);
  });

  it('throws when a question has more options than an OMR sheet can lay out', () => {
    const tooManyOptions = Array.from({ length: MAX_OPTIONS_PER_QUESTION + 1 }, (_, i) => ({
      id: `opt_${String(i)}`,
      text: { en: String(i) },
    }));
    const questions = [eq({ id: 'q1', content_snapshot: { options: tooManyOptions } })];
    expect(() => generateOmrTemplateLayout(questions)).toThrow(OmrLayoutError);
  });
});

describe('computeOmrContentHash', () => {
  it('is deterministic for identical input', () => {
    const questions = [eq({ id: 'q1' }), eq({ id: 'q2', order_index: 1 })];
    expect(computeOmrContentHash(questions)).toBe(computeOmrContentHash(questions));
  });

  it('changes when an option id changes', () => {
    const base = [eq({ id: 'q1' })];
    const changed = [
      eq({
        id: 'q1',
        content_snapshot: {
          options: [
            { id: 'a2', text: { en: 'A' } },
            { id: 'b', text: { en: 'B' } },
          ],
        },
      }),
    ];
    expect(computeOmrContentHash(base)).not.toBe(computeOmrContentHash(changed));
  });

  it('changes when a non-eligible question is inserted (label numbering shifts)', () => {
    const base = [eq({ id: 'q1', order_index: 0 }), eq({ id: 'q2', order_index: 1 })];
    const withEssayInserted = [
      eq({ id: 'q1', order_index: 0 }),
      eq({
        id: 'essay',
        order_index: 1,
        type_snapshot: QuestionType.ESSAY,
        content_snapshot: { prompt: { en: 'e' } },
      }),
      eq({ id: 'q2', order_index: 2 }),
    ];
    expect(computeOmrContentHash(base)).not.toBe(computeOmrContentHash(withEssayInserted));
  });

  it('is independent of input array order (sorts by order_index internally)', () => {
    const a = [eq({ id: 'q1', order_index: 0 }), eq({ id: 'q2', order_index: 1 })];
    const b = [eq({ id: 'q2', order_index: 1 }), eq({ id: 'q1', order_index: 0 })];
    expect(computeOmrContentHash(a)).toBe(computeOmrContentHash(b));
  });
});
