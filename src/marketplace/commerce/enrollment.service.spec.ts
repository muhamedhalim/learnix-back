import { EventEmitter2 } from '@nestjs/event-emitter';

import { MarketplaceEnrollmentStatus } from '../common/enums';
import { EnrollmentService } from './enrollment.service';

function buildEnrollment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'enrollment-1',
    learner_id: 'learner-1',
    course_id: 'course-1',
    order_id: 'order-1',
    status: MarketplaceEnrollmentStatus.ACTIVE,
    revoked_at: null,
    revocation_reason: null,
    ...overrides,
  };
}

function buildService(row: Record<string, unknown> | null) {
  const enrollments = {
    findOne: jest.fn().mockResolvedValue(row),
    save: jest.fn(async (data: Record<string, unknown>) => data),
    find: jest.fn().mockResolvedValue(row ? [row] : []),
  };
  const eventEmitter = new EventEmitter2();
  const emitSpy = jest.spyOn(eventEmitter, 'emit');
  const service = new EnrollmentService(enrollments as never, eventEmitter);
  return { service, enrollments, emitSpy };
}

describe('EnrollmentService (T101)', () => {
  it('revokes an active enrollment with a reason and timestamp, and emits the domain event', async () => {
    const { service, enrollments, emitSpy } = buildService(buildEnrollment());
    const result = await service.revoke('enrollment-1', 'Refund completed');

    expect(result.status).toBe(MarketplaceEnrollmentStatus.REVOKED);
    expect(result.revocation_reason).toBe('Refund completed');
    expect(result.revoked_at).toBeInstanceOf(Date);
    expect(enrollments.save).toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith('marketplace.enrollment.revoked', expect.objectContaining({ enrollmentId: 'enrollment-1', reason: 'Refund completed' }));
  });

  it('suspends an active enrollment with a reason and timestamp', async () => {
    const { service } = buildService(buildEnrollment());
    const result = await service.suspend('enrollment-1', 'Policy investigation');

    expect(result.status).toBe(MarketplaceEnrollmentStatus.SUSPENDED);
    expect(result.revocation_reason).toBe('Policy investigation');
    expect(result.revoked_at).toBeInstanceOf(Date);
  });

  it('reinstates a suspended enrollment back to active, clearing the suspension reason', async () => {
    const { service } = buildService(buildEnrollment({ status: MarketplaceEnrollmentStatus.SUSPENDED, revoked_at: new Date(), revocation_reason: 'Policy investigation' }));
    const result = await service.reinstate('enrollment-1');

    expect(result.status).toBe(MarketplaceEnrollmentStatus.ACTIVE);
    expect(result.revoked_at).toBeNull();
    expect(result.revocation_reason).toBeNull();
  });

  it('refuses to reinstate a revoked (not suspended) enrollment — revocation is terminal', async () => {
    const { service } = buildService(buildEnrollment({ status: MarketplaceEnrollmentStatus.REVOKED }));
    await expect(service.reinstate('enrollment-1')).rejects.toThrow();
  });

  it('404s for a nonexistent enrollment on any transition', async () => {
    const { service } = buildService(null);
    await expect(service.revoke('missing', 'x')).rejects.toThrow();
    await expect(service.suspend('missing', 'x')).rejects.toThrow();
    await expect(service.reinstate('missing')).rejects.toThrow();
  });

  it('listOwnEnrollments eager-loads the course relation — FR-107\'s list has no other way to show a title/slug/cover (T129)', async () => {
    const { service, enrollments } = buildService(buildEnrollment());
    await service.listOwnEnrollments('learner-1');
    expect(enrollments.find).toHaveBeenCalledWith({ where: { learner_id: 'learner-1' }, relations: ['course'], order: { granted_at: 'DESC' } });
  });

  it('getOwnEnrollment scopes strictly by learner_id — another learner\'s enrollment id resolves to null, not a leak (IDOR)', async () => {
    const { service, enrollments } = buildService(buildEnrollment());
    await service.getOwnEnrollment('learner-1', 'enrollment-1');
    expect(enrollments.findOne).toHaveBeenCalledWith({ where: { id: 'enrollment-1', learner_id: 'learner-1' } });
  });

  it('getActiveEnrollment only ever looks for an active-status row', async () => {
    const { service, enrollments } = buildService(buildEnrollment());
    await service.getActiveEnrollment('learner-1', 'course-1');
    expect(enrollments.findOne).toHaveBeenCalledWith({
      where: { learner_id: 'learner-1', course_id: 'course-1', status: MarketplaceEnrollmentStatus.ACTIVE },
    });
  });
});
