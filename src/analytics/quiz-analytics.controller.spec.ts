import { QuizAnalyticsController } from './quiz-analytics.controller';

describe('QuizAnalyticsController student analytics', () => {
  it('always derives the student from the authenticated session', async () => {
    const getStudentAnalytics = jest.fn().mockResolvedValue({ strongTopics: [], weakTopics: [] });
    const controller = new QuizAnalyticsController({ getStudentAnalytics } as never);

    await controller.student(
      { userId: 'authenticated-student' } as never,
      'subject-1',
      undefined,
      undefined,
      undefined,
    );

    expect(getStudentAnalytics).toHaveBeenCalledWith('authenticated-student', { subjectId: 'subject-1' });
  });
});
