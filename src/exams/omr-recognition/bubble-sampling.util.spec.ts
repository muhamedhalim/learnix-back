import { classifyExclusiveMark, classifyIndependentMarks } from './bubble-sampling.util';

describe('classifyExclusiveMark (single_choice / true_false)', () => {
  const threshold = 0.35;

  it('classifies a single clearly-marked bubble as confident', () => {
    const result = classifyExclusiveMark([0.05, 0.9, 0.02, 0.03], threshold);
    expect(result.status).toBe('confident');
    expect(result.selectedIndex).toBe(1);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('classifies all-low ratios as blank with no selected index', () => {
    const result = classifyExclusiveMark([0.02, 0.05, 0.01, 0.03], threshold);
    expect(result.status).toBe('blank');
    expect(result.selectedIndex).toBeNull();
  });

  it('classifies two bubbles both clearing the threshold as multiple_marks', () => {
    const result = classifyExclusiveMark([0.6, 0.62, 0.01, 0.02], threshold);
    expect(result.status).toBe('multiple_marks');
    expect(result.selectedIndex).toBeNull();
  });

  it('classifies a thin-margin single winner as low_confidence, not confident', () => {
    // Winner clears the threshold but the runner-up (itself below threshold) is nearly as dark.
    const result = classifyExclusiveMark([0.36, 0.34, 0.02, 0.01], threshold);
    expect(result.status).toBe('low_confidence');
    expect(result.selectedIndex).toBe(0);
  });

  it('is symmetric under reordering (index tracks the value, not position bias)', () => {
    const a = classifyExclusiveMark([0.9, 0.05, 0.02, 0.03], threshold);
    const b = classifyExclusiveMark([0.03, 0.05, 0.02, 0.9], threshold);
    expect(a.selectedIndex).toBe(0);
    expect(b.selectedIndex).toBe(3);
    expect(a.status).toBe(b.status);
  });

  it('works for a 2-bubble true_false row', () => {
    const trueMarked = classifyExclusiveMark([0.85, 0.02], threshold);
    expect(trueMarked.status).toBe('confident');
    expect(trueMarked.selectedIndex).toBe(0);
  });
});

describe('classifyIndependentMarks (multiple_select)', () => {
  const threshold = 0.35;

  it('selects every bubble clearing the threshold independently', () => {
    const result = classifyIndependentMarks([0.8, 0.05, 0.75, 0.02, 0.9], threshold);
    expect(result.selected).toEqual([true, false, true, false, true]);
    expect(result.status).toBe('confident');
  });

  it('classifies zero marked bubbles as blank', () => {
    const result = classifyIndependentMarks([0.02, 0.05, 0.01], threshold);
    expect(result.selected).toEqual([false, false, false]);
    expect(result.status).toBe('blank');
  });

  it('flags the question for review when any bubble sits in the indeterminate band', () => {
    // 0.34 sits within INDEPENDENT_MARGIN_BAND (0.08) of threshold 0.35.
    const result = classifyIndependentMarks([0.9, 0.34, 0.02], threshold);
    expect(result.status).toBe('low_confidence');
  });

  it('does not flag review when every bubble is decisively on one side', () => {
    const result = classifyIndependentMarks([0.95, 0.05, 0.9], threshold);
    expect(result.status).toBe('confident');
  });
});
