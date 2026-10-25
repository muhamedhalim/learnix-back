import type { Job } from 'bullmq';

import { JOB_TYPES } from '../../queues/queues.constants';
import type { LessonSessionsService } from '../lesson-sessions.service';
import { MeetingProvisioningProcessor } from './meeting-provisioning.processor';

function job(name: string, attemptsMade: number, attempts = 3): Job<{ sessionId: string }> {
  return { name, attemptsMade, opts: { attempts }, data: { sessionId: 's1' } } as unknown as Job<{ sessionId: string }>;
}

describe('MeetingProvisioningProcessor', () => {
  const sessions = {
    provisionMeeting: jest.fn().mockResolvedValue(undefined),
    syncMeetingTime: jest.fn().mockResolvedValue(undefined),
  };
  const processor = new MeetingProvisioningProcessor(sessions as unknown as LessonSessionsService);

  beforeEach(() => jest.clearAllMocks());

  it('passes finalAttempt=false until the last BullMQ attempt', async () => {
    await processor.process(job(JOB_TYPES.MEETING.PROVISION, 0));
    await processor.process(job(JOB_TYPES.MEETING.PROVISION, 1));
    await processor.process(job(JOB_TYPES.MEETING.PROVISION, 2));

    expect(sessions.provisionMeeting.mock.calls.map((call) => call[1])).toEqual([
      { finalAttempt: false },
      { finalAttempt: false },
      { finalAttempt: true },
    ]);
  });

  it('routes sync jobs to syncMeetingTime', async () => {
    await processor.process(job(JOB_TYPES.MEETING.SYNC, 2));

    expect(sessions.syncMeetingTime).toHaveBeenCalledWith('s1', { finalAttempt: true });
    expect(sessions.provisionMeeting).not.toHaveBeenCalled();
  });

  it('ignores unknown job names', async () => {
    await processor.process(job('something-else', 0));

    expect(sessions.provisionMeeting).not.toHaveBeenCalled();
    expect(sessions.syncMeetingTime).not.toHaveBeenCalled();
  });
});
