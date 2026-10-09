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

    expect(getStudentAnalytics).toHaveBeenCalledWith('authenticated-student', {
      subjectId: 'subject-1',
    });
  });

  it('T062: view=summary asks the service for the summary view; anything else keeps the full response', async () => {
    const getStudentAnalytics = jest.fn().mockResolvedValue({ totalAttempts: 2, averageScore: 80 });
    const controller = new QuizAnalyticsController({ getStudentAnalytics } as never);
    const user = { userId: 'authenticated-student' } as never;

    await expect(
      controller.student(user, undefined, undefined, undefined, undefined, 'summary'),
    ).resolves.toEqual({ data: { totalAttempts: 2, averageScore: 80 } });
    expect(getStudentAnalytics).toHaveBeenLastCalledWith('authenticated-student', {}, 'summary');

    await controller.student(user, undefined, undefined, undefined, undefined, 'bogus');
    expect(getStudentAnalytics).toHaveBeenLastCalledWith('authenticated-student', {});
  });

  it('uses the authenticated user ID as the teacher ownership identifier and preserves the API envelope', async () => {
    const analytics = { totalAttempts: 0, attemptTimeline: [] };
    const getTeacherAnalytics = jest.fn().mockResolvedValue(analytics);
    const controller = new QuizAnalyticsController({ getTeacherAnalytics } as never);

    await expect(controller.teacher({ userId: 'authenticated-teacher' } as never)).resolves.toEqual(
      {
        data: analytics,
      },
    );
    expect(getTeacherAnalytics).toHaveBeenCalledWith('authenticated-teacher');
  });
});
