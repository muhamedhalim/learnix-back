import type { Request } from 'express';

import { SessionController } from './session.controller';

function requestWith(headers: Record<string, string | string[] | undefined>, ip?: string): Request {
  return { headers, ip } as unknown as Request;
}

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

  describe('enterLesson client IP resolution (AUD-001)', () => {
    function build() {
      const attendance = { enterLesson: jest.fn().mockResolvedValue({ id: 'session-1' }) };
      return { attendance, controller: new SessionController(attendance as never) };
    }

    it('records the first forwarded hop when the proxy supplied one', async () => {
      const { attendance, controller } = build();

      await controller.enterLesson(
        { userId: 'student-1' } as never,
        'lesson-1',
        requestWith({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'jest' }, '10.0.0.1'),
      );

      expect(attendance.enterLesson).toHaveBeenCalledWith(
        'student-1',
        'lesson-1',
        '203.0.113.7',
        'jest',
      );
    });

    it('does NOT throw and falls back to request.ip when x-forwarded-for is absent', async () => {
      const { attendance, controller } = build();

      await expect(
        controller.enterLesson(
          { userId: 'student-1' } as never,
          'lesson-1',
          requestWith({ 'user-agent': 'jest' }, '10.0.0.1'),
        ),
      ).resolves.toMatchObject({ message: 'Session started' });

      expect(attendance.enterLesson).toHaveBeenCalledWith(
        'student-1',
        'lesson-1',
        '10.0.0.1',
        'jest',
      );
    });

    it('starts the session even when neither a forwarded header nor request.ip exists', async () => {
      const { attendance, controller } = build();

      await expect(
        controller.enterLesson({ userId: 'student-1' } as never, 'lesson-1', requestWith({})),
      ).resolves.toMatchObject({ message: 'Session started' });

      expect(attendance.enterLesson).toHaveBeenCalledWith(
        'student-1',
        'lesson-1',
        undefined,
        undefined,
      );
    });

    it('takes the leftmost address from a multi-hop forwarded chain', async () => {
      const { attendance, controller } = build();

      await controller.enterLesson(
        { userId: 'student-1' } as never,
        'lesson-1',
        requestWith({ 'x-forwarded-for': '203.0.113.7, 198.51.100.4, 10.0.0.9' }, '10.0.0.1'),
      );

      expect(attendance.enterLesson).toHaveBeenCalledWith(
        'student-1',
        'lesson-1',
        '203.0.113.7',
        undefined,
      );
    });

    it('falls back to request.ip for a malformed/blank forwarded header', async () => {
      const { attendance, controller } = build();

      await controller.enterLesson(
        { userId: 'student-1' } as never,
        'lesson-1',
        requestWith({ 'x-forwarded-for': '   ' }, '10.0.0.1'),
      );

      expect(attendance.enterLesson).toHaveBeenCalledWith(
        'student-1',
        'lesson-1',
        '10.0.0.1',
        undefined,
      );
    });
  });
});
