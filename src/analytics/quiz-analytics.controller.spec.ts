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
