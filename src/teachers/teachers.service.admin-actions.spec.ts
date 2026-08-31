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

  /** Minimal `ProductFinancialMetrics` shape with only the fields read here. */
  const financialMetrics = (teacherEarningsMinor: number, currency = 'EGP') => ({
    primary: { currency, teacher_earnings_minor: teacherEarningsMinor },
    by_currency: [],
    mixed_currency: false,
  });

  const build = (
    overrides: {
      found?: unknown;
      query?: jest.Mock;
      teacherEarningsMinor?: number;
      uniqueStudents?: number;
      rating?: { average_rating: number; total_reviews: number };
    } = {},
  ) => {
    const recordAuditEvent = jest.fn().mockResolvedValue(undefined);
    const save = jest.fn().mockResolvedValue(undefined);
    // `?? profile()` would swallow an explicit `found: null`, so branch on the
    // key's presence instead.
    const foundProfile = 'found' in overrides ? overrides.found : profile();
    const findOne = jest.fn().mockResolvedValue(foundProfile);
    const query = overrides.query ?? jest.fn().mockResolvedValue([]);

    // approveTeacher/rejectTeacher run inside `dataSource.transaction` (a
    // pessimistic lock on the user row closes a double-click/concurrent-call
    // race — see teachers.service.ts). The transactional `manager` is a
    // separate object from the repositories above, so it needs its own
    // `findOne`/`save` doubles that dispatch by entity class the same way the
    // real EntityManager would.
    const transactionManager = {
      findOne: jest.fn(async (entity: unknown, options: unknown) => {
        if (entity === User) {
          return (foundProfile as { user?: unknown } | null)?.user ?? null;
        }
        return findOne(options);
      }),
      save: jest.fn(async (_entity: unknown, value: unknown) => {
        await save(value);
        return value;
      }),
    };
    const transaction = jest.fn(
      async (callback: (manager: typeof transactionManager) => Promise<unknown>) =>
        callback(transactionManager),
    );

    const getTeacherFinancialMetrics = jest
      .fn()
      .mockResolvedValue(financialMetrics(overrides.teacherEarningsMinor ?? 0));
    const getTeacherUniqueStudentCount = jest.fn().mockResolvedValue(overrides.uniqueStudents ?? 0);
    const getTeacherAggregates = jest
      .fn()
      .mockResolvedValue(
        overrides.rating ?? { average_rating: 0, total_reviews: 0, rating_distribution: {} },
      );

    const service = new TeachersService(
      { findOne } as unknown as Repository<TeacherProfile>,
      { save } as unknown as Repository<User>,
      {} as unknown as Repository<Subject>,
      { query, transaction } as unknown as DataSource,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as unknown as ApplicationCacheService,
      {} as unknown as MediaService,
      { recordAuditEvent } as unknown as ActivityLogsService,
      { getTeacherAggregates } as never,
      { getTeacherFinancialMetrics, getTeacherUniqueStudentCount } as never,
    );

    // `mapToProfileWithDetails` is not under test here.
    jest
      .spyOn(
        service as unknown as { mapToProfileWithDetails: () => unknown },
        'mapToProfileWithDetails',
      )
      .mockResolvedValue({});

    return {
      service,
      recordAuditEvent,
      findOne,
      query,
      save,
      getTeacherFinancialMetrics,
      getTeacherUniqueStudentCount,
      getTeacherAggregates,
    };
  };

  describe('getTeacherStats', () => {
    it('reports ledger-backed figures keyed on users.id, not the profile id', async () => {
      const query = jest.fn().mockResolvedValueOnce([{ lessons_count: '7' }]);
      const {
        service,
        getTeacherFinancialMetrics,
        getTeacherUniqueStudentCount,
        getTeacherAggregates,
      } = build({
        query,
        teacherEarningsMinor: 154_000,
        uniqueStudents: 23,
        rating: { average_rating: 4.5, total_reviews: 12 },
      });

      const stats = await service.getTeacherStats('profile-1');

      expect(stats).toEqual({
        lessonsCount: 7,
        studentsCount: 23,
        // Minor units, matching every other financial figure the API returns.
        totalEarnings: 154_000,
        currency: 'EGP',
        averageRating: 4.5,
        reviewCount: 12,
      });
      // Content and commerce rows key on users.id, never the profile id.
      expect(query.mock.calls[0][1]).toEqual(['user-1']);
      expect(getTeacherFinancialMetrics).toHaveBeenCalledWith('user-1');
      expect(getTeacherUniqueStudentCount).toHaveBeenCalledWith('user-1');
      expect(getTeacherAggregates).toHaveBeenCalledWith('user-1');
    });

    it('delegates earnings to the canonical metrics service rather than its own SQL', async () => {
      const query = jest.fn().mockResolvedValueOnce([{ lessons_count: '0' }]);
      const { service, getTeacherFinancialMetrics } = build({ query });

      await service.getTeacherStats('profile-1');

      // Exactly one query is issued here (the lesson count); every financial
      // figure comes from ProductFinancialMetricsService, so a competing
      // `status = 'paid'` formula cannot creep back into this service.
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toContain('FROM lessons');
      expect(getTeacherFinancialMetrics).toHaveBeenCalledTimes(1);
    });

    it('reports an unrated teacher as null, not zero stars', async () => {
      const { service } = build({ query: jest.fn().mockResolvedValue([]) });

      await expect(service.getTeacherStats('profile-1')).resolves.toEqual({
        lessonsCount: 0,
        studentsCount: 0,
        totalEarnings: 0,
        currency: 'EGP',
        averageRating: null,
        reviewCount: 0,
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

      await expect(
        service.approveTeacher('profile-1', undefined, 'admin-9'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(recordAuditEvent).not.toHaveBeenCalled();
    });
  });

  describe('rejectTeacher', () => {
    it('records the rejection reason in the audit trail', async () => {
      const { service, recordAuditEvent } = build();

      await service.rejectTeacher(
        'profile-1',
        { reason: 'Invalid credentials' },
        'admin-9',
        '10.0.0.2',
      );

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
