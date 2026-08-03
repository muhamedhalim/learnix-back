import { SessionController } from './session.controller';

describe('SessionController', () => {
  it('scopes progress updates to the authenticated student', async () => {
    const attendance = { updateSessionProgress: jest.fn().mockResolvedValue({ id: 'session-1' }) };
    const controller = new SessionController(attendance as never);

    await controller.updateProgress(
      { userId: 'student-1' } as never,
      'session-1',
      { video_progress_percent: 75 },
    );

    expect(attendance.updateSessionProgress).toHaveBeenCalledWith('session-1', 'student-1', 75);
  });
});
