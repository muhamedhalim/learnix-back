import { StudentPracticeController } from './student-practice.controller';

describe('StudentPracticeController', () => {
  it('keeps the practice API restricted to the student role', () => {
    expect(Reflect.getMetadata('roles', StudentPracticeController)).toEqual(['student']);
  });

  it('derives the scorer identity from the authenticated session, never the request body', async () => {
    const submitAnswer = jest.fn().mockResolvedValue({ isCorrect: true });
    const controller = new StudentPracticeController(
      { submitAnswer } as never,
      {} as never,
    );

    await controller.answer(
      { userId: 'authenticated-student' } as never,
      {
        question_id: '9a00422f-b5da-4731-b6a8-aae09cb1ebfc',
        response: { optionId: 'correct' },
        time_ms: 5_000,
      },
    );

    expect(submitAnswer).toHaveBeenCalledWith('authenticated-student', {
      questionId: '9a00422f-b5da-4731-b6a8-aae09cb1ebfc',
      response: { optionId: 'correct' },
      timeMs: 5_000,
      sessionId: null,
    });
  });
});
