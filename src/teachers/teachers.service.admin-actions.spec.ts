import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { ActivityLogsService } from '../activity-logs/activity-logs.service';
import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { MediaService } from '../media/media.service';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { UserStatus } from '../users/entities/user-status.enum';
import { TeacherProfile } from './entities/teacher-profile.entity';
import { TeachersService } from './teachers.service';

/**
 * Covers the two behaviours this page depends on that were previously stubbed:
 * real teacher statistics, and an audit record for every approve/reject.
 */
describe('TeachersService administrative actions', () => {
  const profile = () => ({
    id: 'profile-1',
    user_id: 'user-1',
    rating: 4.5,
    user: {
      id: 'user-1',
      name: 'Layla Hassan',
      email: 'layla@example.test',
      status: UserStatus.PENDING,
      rejection_reason: null as string | null,
    },
    subjects: [],
  });

  const build = (overrides: {
    found?: unknown;
    query?: jest.Mock;
  } = {}) => {
    const recordAuditEvent = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockResolvedValue(undefined);
    // `?? profile()` would swallow an explicit `found: null`, so branch on the
    // key's presence instead.
    const findOne = jest
      .fn()
      .mockResolvedValue('found' in overrides ? overrides.found : profile());
    const query = overrides.query ?? jest.fn().mockResolvedValue([]);

    const service = new TeachersService(
      { findOne } as unknown as Repository<TeacherProfile>,
      { save } as unknown as Repository<User>,
      {} as unknown as Repository<Subject>,
      { query } as unknown as DataSource,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as unknown as ApplicationCacheService,
      {} as unknown as MediaService,
      { recordAuditEvent } as unknown as ActivityLogsService,
    );

    // `mapToProfileWithDetails` is not under test here.
    jest
      .spyOn(service as unknown as { mapToProfileWithDetails: () => unknown }, 'mapToProfileWithDetails')
      .mockReturnValue({});

    return { service, recordAuditEvent, findOne, query, save };
  };

  describe('getTeacherStats', () => {
    it('reports ledger-backed figures keyed on users.id, not the profile id', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce([{ lessons_count: '7' }])
        .mockResolvedValueOnce([{ students_count: '23', total_earnings_minor: '154000' }]);
      const { service } = build({ query });

      const stats = await service.getTeacherStats('profile-1');

      expect(stats).toEqual({
        lessonsCount: 7,
        studentsCount: 23,
        // Minor units, matching every other financial figure the API returns.
        totalEarnings: 154_000,
        averageRating: 4.5,
      });
      // Content and commerce rows key on users.id.
      expect(query.mock.calls[0][1]).toEqual(['user-1']);
      expect(query.mock.calls[1][1]).toEqual(['user-1']);
    });

    it('counts only paid orders towards earnings and students', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce([{ lessons_count: '0' }])
        .mockResolvedValueOnce([{ students_count: '0', total_earnings_minor: '0' }]);
      const { service } = build({ query });

      await service.getTeacherStats('profile-1');

      expect(query.mock.calls[1][0]).toContain("status = 'paid'");
      expect(query.mock.calls[1][0]).toContain('teacher_earning_minor');
    });

    it('returns zeros rather than NaN when a teacher has no activity', async () => {
      const { service } = build({ query: jest.fn().mockResolvedValue([]) });

      await expect(service.getTeacherStats('profile-1')).resolves.toEqual({
        lessonsCount: 0,
        studentsCount: 0,
        totalEarnings: 0,
        averageRating: 4.5,
      });
    });

    it('rejects an unknown teacher', async () => {
      const { service } = build({ found: null });

      await expect(service.getTeacherStats('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('approveTeacher', () => {
    it('records exactly one audit event naming the actor, target, and notes', async () => {
      const { service, recordAuditEvent } = build();

      await service.approveTeacher('profile-1', '  verified credentials  ', 'admin-9', '10.0.0.1');

      expect(recordAuditEvent).toHaveBeenCalledTimes(1);
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: 'admin-9',
          action: 'user_approved',
          targetType: 'user',
          targetId: 'user-1',
          ipAddress: '10.0.0.1',
          details: expect.objectContaining({
            userRole: 'teacher',
            notes: 'verified credentials',
          }),
        }),
      );
    });

    it('omits the notes key when no justification was supplied', async () => {
      const { service, recordAuditEvent } = build();

      await service.approveTeacher('profile-1', '   ', 'admin-9');

      expect(recordAuditEvent.mock.calls[0][0].details).not.toHaveProperty('notes');
    });

    it('skips the audit write for internal callers with no request context', async () => {
      const { service, recordAuditEvent } = build();

      await service.approveTeacher('profile-1');

      expect(recordAuditEvent).not.toHaveBeenCalled();
    });

    it('refuses to re-approve an already approved teacher', async () => {
      const already = profile();
      already.user.status = UserStatus.APPROVED;
      const { service, recordAuditEvent } = build({ found: already });

      await expect(service.approveTeacher('profile-1', undefined, 'admin-9')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(recordAuditEvent).not.toHaveBeenCalled();
    });
  });

  describe('rejectTeacher', () => {
    it('records the rejection reason in the audit trail', async () => {
      const { service, recordAuditEvent } = build();

      await service.rejectTeacher('profile-1', { reason: 'Invalid credentials' }, 'admin-9', '10.0.0.2');

      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: 'admin-9',
          action: 'user_rejected',
          targetId: 'user-1',
          ipAddress: '10.0.0.2',
          details: expect.objectContaining({ reason: 'Invalid credentials' }),
        }),
      );
    });

    it('refuses to re-reject an already rejected teacher', async () => {
      const already = profile();
      already.user.status = UserStatus.REJECTED;
      const { service, recordAuditEvent } = build({ found: already });

      await expect(
        service.rejectTeacher('profile-1', { reason: 'again' }, 'admin-9'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(recordAuditEvent).not.toHaveBeenCalled();
    });
  });
});
