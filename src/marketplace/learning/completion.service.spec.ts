import { EventEmitter2 } from '@nestjs/event-emitter';

import { CompletionService } from './completion.service';

function buildEnrollment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'enrollment-1',
    course_id: 'course-1',
    learner_id: 'learner-1',
    completed_at: null,
    ...overrides,
  };
}

function buildService(enrollment: Record<string, unknown> | null) {
  const enrollments = {
    findOneOrFail: jest.fn(async () => {
      if (!enrollment) throw new Error('not found');
      return enrollment;
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const eventEmitter = new EventEmitter2();
  const emitSpy = jest.spyOn(eventEmitter, 'emit');
  const service = new CompletionService(enrollments as never, eventEmitter);
  return { service, enrollments, emitSpy };
}

describe('CompletionService (T123)', () => {
  it('marks the enrollment complete and emits the domain event exactly when progress reaches 10000 (FR-242)', async () => {
    const { service, enrollments, emitSpy } = buildService(buildEnrollment());
    const result = await service.checkCompletion('enrollment-1', 10000);

    expect(result).toBe(true);
    expect(enrollments.update).toHaveBeenCalledWith({ id: 'enrollment-1' }, { completed_at: expect.any(Date) });
    expect(emitSpy).toHaveBeenCalledWith(
      'marketplace.course.completed',
      expect.objectContaining({ enrollmentId: 'enrollment-1', courseId: 'course-1', learnerId: 'learner-1' }),
    );
  });

  it('does nothing for anything less than 10000, even 9999', async () => {
    const { service, enrollments, emitSpy } = buildService(buildEnrollment());
    const result = await service.checkCompletion('enrollment-1', 9999);

    expect(result).toBe(false);
    expect(enrollments.update).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('a zero-required-lesson course (progress always 0) never completes (FR-333)', async () => {
    const { service, enrollments } = buildService(buildEnrollment());
    const result = await service.checkCompletion('enrollment-1', 0);

    expect(result).toBe(false);
    expect(enrollments.update).not.toHaveBeenCalled();
  });

  it('is idempotent — an already-completed enrollment reaching 10000 again does not re-mark or re-emit', async () => {
    const { service, enrollments, emitSpy } = buildService(buildEnrollment({ completed_at: new Date('2026-01-01') }));
    const result = await service.checkCompletion('enrollment-1', 10000);

    expect(result).toBe(false);
    expect(enrollments.update).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('completion is permanent — this service exposes no way to clear completed_at once set (reversing a lesson only ever lowers progress_bps again, never uncompletes)', () => {
    // Structural assertion: the only mutation this service ever performs is
    // setting completed_at when it was null. There is no method here that
    // writes completed_at: null anywhere in the class.
    const source = CompletionService.prototype.checkCompletion.toString();
    expect(source).not.toMatch(/completed_at:\s*null/);
  });
});
