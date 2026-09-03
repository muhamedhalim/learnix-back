import type { EventEmitter2 } from '@nestjs/event-emitter';

import type { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { MarketplaceCourseStatus } from '../common/enums';
import type { CourseReadinessService, ReadinessResult } from './course-readiness.service';
import type { CourseVersionService } from './course-version.service';
import { CourseLifecycleService } from './course-lifecycle.service';
import type { MarketplaceCourse } from './entities';

function buildCourse(overrides: Partial<MarketplaceCourse> = {}): MarketplaceCourse {
  return {
    id: 'course-1',
    instructor_id: 'instr-1',
    title: 'Test Course',
    status: MarketplaceCourseStatus.DRAFT,
    first_published_at: null,
    last_published_at: null,
    ...overrides,
  } as unknown as MarketplaceCourse;
}

function buildService(
  course: MarketplaceCourse | null,
  readinessResult: ReadinessResult = { ready: true, items: [] },
) {
  const courses = {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (!course) return null;
      const matches = Object.entries(where).every(
        ([key, value]) => (course as unknown as Record<string, unknown>)[key] === value,
      );
      return matches ? course : null;
    }),
    save: jest.fn(async (entity: MarketplaceCourse) => entity),
    update: jest.fn(async (criteria: { status?: string }, partial: Partial<MarketplaceCourse>) => {
      if (course && (!criteria.status || course.status === criteria.status)) {
        Object.assign(course, partial);
        return { affected: 1 };
      }
      return { affected: 0 };
    }),
  };
  const decisions = {
    create: jest.fn((data: unknown) => data),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const readiness = {
    evaluate: jest.fn().mockResolvedValue(readinessResult),
  } as unknown as jest.Mocked<CourseReadinessService>;
  const versions = {
    publishSnapshot: jest.fn().mockResolvedValue({ id: 'version-1', version_number: 1 }),
  } as unknown as jest.Mocked<CourseVersionService>;
  const activityLogs = {
    recordAuditEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ActivityLogsService>;
  const eventEmitter = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;
  const service = new CourseLifecycleService(
    courses as never,
    decisions as never,
    readiness,
    versions,
    activityLogs,
    eventEmitter,
  );
  return { service, courses, decisions, readiness, versions, activityLogs, eventEmitter };
}

describe('CourseLifecycleService — FR-059/FR-060 state machine', () => {
  describe('submit', () => {
    it('draft → submitted_for_review when ready', async () => {
      const { service } = buildService(buildCourse({ status: MarketplaceCourseStatus.DRAFT }));
      const result = await service.submit('instr-1', 'course-1');
      expect(result.status).toBe(MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW);
    });

    it('rejected → submitted_for_review when ready (resubmission)', async () => {
      const { service } = buildService(buildCourse({ status: MarketplaceCourseStatus.REJECTED }));
      const result = await service.submit('instr-1', 'course-1');
      expect(result.status).toBe(MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW);
    });

    it('refuses when not ready, listing every failed item (FR-056)', async () => {
      const { service } = buildService(buildCourse(), {
        ready: false,
        items: [
          { key: 'title', passed: false },
          { key: 'cover_image', passed: false },
        ],
      });
      await expect(service.submit('instr-1', 'course-1')).rejects.toMatchObject({
        response: expect.objectContaining({ details: ['title', 'cover_image'] }),
      });
    });

    it.each([
      MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW,
      MarketplaceCourseStatus.APPROVED,
      MarketplaceCourseStatus.PUBLISHED,
      MarketplaceCourseStatus.UNPUBLISHED,
    ])('refuses to submit from %s', async (status) => {
      const { service } = buildService(buildCourse({ status }));
      await expect(service.submit('instr-1', 'course-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'COURSE_ILLEGAL_TRANSITION' }),
      });
    });

    it('refuses to submit a course owned by a different instructor (no IDOR)', async () => {
      const { service } = buildService(buildCourse({ instructor_id: 'instr-1' }));
      await expect(service.submit('instr-2', 'course-1')).rejects.toThrow();
    });
  });

  describe('approve / reject', () => {
    it('submitted_for_review → approved, recording a decision row, an audit record and a domain event (FR-290)', async () => {
      const { service, decisions, activityLogs, eventEmitter } = buildService(
        buildCourse({ status: MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW }),
      );
      await service.approve('admin-1', 'course-1');
      expect(decisions.save).toHaveBeenCalled();
      expect(decisions.create).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approved', reviewed_by: 'admin-1' }),
      );
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.course.approved',
        expect.objectContaining({ courseId: 'course-1', instructorId: 'instr-1' }),
      );
    });

    it('submitted_for_review → rejected, recording reasons and item notes (FR-066), an audit record and a domain event', async () => {
      const { service, decisions, activityLogs, eventEmitter } = buildService(
        buildCourse({ status: MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW }),
      );
      await service.reject('admin-1', 'course-1', ['Missing curriculum'], { lessons: 'add more' });
      expect(decisions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'rejected',
          reasons: ['Missing curriculum'],
          item_notes: { lessons: 'add more' },
        }),
      );
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.course.rejected',
        expect.objectContaining({ courseId: 'course-1', reasons: ['Missing curriculum'] }),
      );
    });

    it('refuses to approve a course not currently submitted_for_review', async () => {
      const { service } = buildService(buildCourse({ status: MarketplaceCourseStatus.DRAFT }));
      await expect(service.approve('admin-1', 'course-1')).rejects.toThrow();
    });

    it('FR-073: a second reviewer loses the race — told the course was already decided, not silently overwritten', async () => {
      const course = buildCourse({ status: MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW });
      const { service, courses } = buildService(course);
      await service.approve('admin-1', 'course-1');
      expect(course.status).toBe(MarketplaceCourseStatus.APPROVED);

      // A second reviewer's concurrent decision now finds the row no longer submitted_for_review.
      await expect(service.reject('admin-2', 'course-1', ['Too late'])).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'COURSE_ALREADY_DECIDED' }),
      });
      expect(courses.update).toHaveBeenCalledTimes(2);
    });
  });

  describe('publish', () => {
    it('approved → published, stamping first_published_at once, last_published_at every time, and taking the first version snapshot (FR-074)', async () => {
      const { service, versions } = buildService(
        buildCourse({ status: MarketplaceCourseStatus.APPROVED, first_published_at: null }),
      );
      const result = await service.publish('instr-1', 'course-1');
      expect(result.status).toBe(MarketplaceCourseStatus.PUBLISHED);
      expect(result.first_published_at).toBeInstanceOf(Date);
      expect(result.last_published_at).toBeInstanceOf(Date);
      expect(versions.publishSnapshot).toHaveBeenCalledWith('course-1', 'instr-1');
    });

    it('never advances first_published_at on a later republish', async () => {
      const firstPublish = new Date('2026-01-01T00:00:00Z');
      const { service } = buildService(
        buildCourse({ status: MarketplaceCourseStatus.APPROVED, first_published_at: firstPublish }),
      );
      const result = await service.publish('instr-1', 'course-1');
      expect(result.first_published_at).toBe(firstPublish);
    });

    it('refuses to publish a course that is not approved', async () => {
      const { service } = buildService(buildCourse({ status: MarketplaceCourseStatus.DRAFT }));
      await expect(service.publish('instr-1', 'course-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'COURSE_ILLEGAL_TRANSITION' }),
      });
    });
  });

  describe('unpublish / republish / reopenForEdit', () => {
    it('published → unpublished (instructor self-service): no audit record, still emits the domain event', async () => {
      const { service, activityLogs, eventEmitter } = buildService(
        buildCourse({ status: MarketplaceCourseStatus.PUBLISHED }),
      );
      const result = await service.unpublish('course-1');
      expect(result.status).toBe(MarketplaceCourseStatus.UNPUBLISHED);
      expect(activityLogs.recordAuditEvent).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.course.unpublished',
        expect.objectContaining({ courseId: 'course-1', instructorId: 'instr-1' }),
      );
    });

    it('adminUnpublish (FR-068): reason mandatory at the DTO layer, but this always records an audit event (FR-290)', async () => {
      const { service, activityLogs, eventEmitter } = buildService(
        buildCourse({ status: MarketplaceCourseStatus.PUBLISHED }),
      );
      const result = await service.adminUnpublish(
        'admin-1',
        'course-1',
        'Outdated content pending revision',
      );
      expect(result.status).toBe(MarketplaceCourseStatus.UNPUBLISHED);
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.course.unpublished',
        expect.objectContaining({ courseId: 'course-1' }),
      );
    });

    it('unpublished → published (republish, still approved, no new review) and takes a fresh snapshot so edits made while unpublished are not stale', async () => {
      const { service, versions } = buildService(
        buildCourse({ status: MarketplaceCourseStatus.UNPUBLISHED }),
      );
      const result = await service.republish('instr-1', 'course-1');
      expect(result.status).toBe(MarketplaceCourseStatus.PUBLISHED);
      expect(versions.publishSnapshot).toHaveBeenCalledWith('course-1', 'instr-1');
    });

    it('unpublished → draft (reopened for edit)', async () => {
      const { service } = buildService(
        buildCourse({ status: MarketplaceCourseStatus.UNPUBLISHED }),
      );
      const result = await service.reopenForEdit('instr-1', 'course-1');
      expect(result.status).toBe(MarketplaceCourseStatus.DRAFT);
    });

    it('refuses to republish a permanently removed course (T142, FR-054a)', async () => {
      const { service } = buildService(
        buildCourse({ status: MarketplaceCourseStatus.UNPUBLISHED, removed_at: new Date() }),
      );
      await expect(service.republish('instr-1', 'course-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'COURSE_PERMANENTLY_REMOVED' }),
      });
    });

    it('refuses to reopen a permanently removed course for editing (T142, FR-054a)', async () => {
      const { service } = buildService(
        buildCourse({ status: MarketplaceCourseStatus.UNPUBLISHED, removed_at: new Date() }),
      );
      await expect(service.reopenForEdit('instr-1', 'course-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'COURSE_PERMANENTLY_REMOVED' }),
      });
    });

    it('refuses to unpublish a course that is not published', async () => {
      const { service } = buildService(buildCourse({ status: MarketplaceCourseStatus.DRAFT }));
      await expect(service.unpublish('course-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'COURSE_ILLEGAL_TRANSITION' }),
      });
    });

    it.each([
      ['republish', MarketplaceCourseStatus.DRAFT],
      ['reopenForEdit', MarketplaceCourseStatus.PUBLISHED],
    ] as const)('refuses %s from an illegal source status', async (method, status) => {
      const { service } = buildService(buildCourse({ status }));
      await expect(
        (service[method] as (i: string, c: string) => Promise<unknown>)('instr-1', 'course-1'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'COURSE_ILLEGAL_TRANSITION' }),
      });
    });
  });
});
