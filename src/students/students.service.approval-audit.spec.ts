import { ConflictException } from '@nestjs/common';

import { UserApprovedEvent, UserRejectedEvent } from '../activity-logs/events/audit.events';
import { UserStatus } from '../users/entities/user-status.enum';
import { StudentsService } from './students.service';

describe('StudentsService approval audit (F-15)', () => {
  function build(status: UserStatus) {
    const user = { id: 'u1', name: 'Sara', email: 's@x.test', status, rejection_reason: null };
    const profile = { id: 'p1', user_id: 'u1', user };
    const profiles = { findOne: jest.fn().mockResolvedValue(profile) };
    const users = { save: jest.fn().mockResolvedValue(user) };
    const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const activityLogs = { recordAuditEvent: jest.fn().mockResolvedValue(undefined) };
    const service = new StudentsService(
      profiles as never,
      users as never,
      {} as never,
      {} as never,
      cache as never,
      {} as never,
      {} as never,
      activityLogs as never,
    );
    jest
      .spyOn(service as unknown as { mapToProfileWithDetails: () => unknown }, 'mapToProfileWithDetails')
      .mockReturnValue({});
    return { service, activityLogs, users };
  }

  it('records an audit row with actor, notes and ip when approving', async () => {
    const { service, activityLogs } = build(UserStatus.PENDING);
    await service.approveStudent('p1', ' ok ', 'admin-1', '1.2.3.4');
    const event = (activityLogs.recordAuditEvent.mock.calls[0] as [UserApprovedEvent])[0];
    expect(event).toBeInstanceOf(UserApprovedEvent);
    expect(event).toMatchObject({
      adminId: 'admin-1',
      action: 'user_approved',
      targetId: 'u1',
      ipAddress: '1.2.3.4',
    });
    expect(event.details).toMatchObject({ userRole: 'student', notes: 'ok' });
  });

  it('records the rejection reason when rejecting', async () => {
    const { service, activityLogs } = build(UserStatus.PENDING);
    await service.rejectStudent('p1', { reason: 'Incomplete data' }, 'admin-1', '1.2.3.4');
    const event = (activityLogs.recordAuditEvent.mock.calls[0] as [UserRejectedEvent])[0];
    expect(event).toBeInstanceOf(UserRejectedEvent);
    expect(event.details).toMatchObject({ reason: 'Incomplete data', userRole: 'student' });
  });

  it('writes no audit row when the decision is a conflict', async () => {
    const { service, activityLogs } = build(UserStatus.APPROVED);
    await expect(service.approveStudent('p1', undefined, 'admin-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(activityLogs.recordAuditEvent).not.toHaveBeenCalled();
  });
});
