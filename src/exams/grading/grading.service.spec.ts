import { QuestionType } from '../entities';
import { QuestionTypeRegistry } from '../question-types/question-type-registry';
import { GradingService } from './grading.service';

describe('GradingService', () => {
  const service = new GradingService(new QuestionTypeRegistry());

  it('scores a correct objective answer at full marks', () => {
    const result = service.gradeAnswer({
      type: QuestionType.SINGLE_CHOICE,
      answerKey: { correctOptionId: 'a' },
      response: { optionId: 'a' },
      marks: 5,
      negativeMarking: false,
    });
    expect(result).toEqual({
      score: 5,
      maxScore: 5,
      isCorrect: true,
      autoGraded: true,
      manualRequired: false,
    });
  });

  it('scores a wrong answer at 0 without negative marking', () => {
    const result = service.gradeAnswer({
      type: QuestionType.SINGLE_CHOICE,
      answerKey: { correctOptionId: 'a' },
      response: { optionId: 'b' },
      marks: 5,
      negativeMarking: false,
    });
    expect(result.score).toBe(0);
    expect(result.isCorrect).toBe(false);
  });

  it('applies a 25% penalty to a wrong (attempted) answer under negative marking', () => {
    const result = service.gradeAnswer({
      type: QuestionType.SINGLE_CHOICE,
      answerKey: { correctOptionId: 'a' },
      response: { optionId: 'b' },
      marks: 4,
      negativeMarking: true,
    });
    expect(result.score).toBe(-1); // -(4 * 0.25)
  });

  it('never penalises an unanswered question even with negative marking', () => {
    const result = service.gradeAnswer({
      type: QuestionType.SINGLE_CHOICE,
      answerKey: { correctOptionId: 'a' },
      response: null,
      marks: 4,
      negativeMarking: true,
    });
    expect(result.score).toBe(0);
  });

  it('awards proportional marks for partial multiple-select', () => {
    const result = service.gradeAnswer({
      type: QuestionType.MULTIPLE_SELECT,
      answerKey: { correctOptionIds: ['a', 'b', 'c', 'd'] },
      response: { optionIds: ['a', 'b'] },
      marks: 8,
      negativeMarking: false,
    });
    expect(result.score).toBe(4); // 0.5 * 8
    expect(result.autoGraded).toBe(true);
  });

  it('returns a pending manual result for essays', () => {
    const result = service.gradeAnswer({
      type: QuestionType.ESSAY,
      answerKey: {},
      response: { text: 'my essay' },
      marks: 10,
      negativeMarking: false,
    });
    expect(result).toEqual({
      score: 0,
      maxScore: 10,
      isCorrect: null,
      autoGraded: false,
      manualRequired: true,
    });
  });
});
