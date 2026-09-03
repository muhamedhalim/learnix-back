import { AccessService } from './access.service';

function buildService(
  activeEnrollment: Record<string, unknown> | null,
  ownEnrollment: Record<string, unknown> | null = activeEnrollment,
) {
  const enrollments = {
    getActiveEnrollment: jest.fn().mockResolvedValue(activeEnrollment),
    getOwnEnrollment: jest.fn().mockResolvedValue(ownEnrollment),
  };
  return { service: new AccessService(enrollments as never), enrollments };
}

describe('AccessService (T102)', () => {
  it('grants access when an active enrollment exists', async () => {
    const enrollment = { id: 'enrollment-1' };
    const { service } = buildService(enrollment);
    await expect(service.verifyAccess('learner-1', 'course-1')).resolves.toBe(enrollment);
    await expect(service.hasAccess('learner-1', 'course-1')).resolves.toBe(true);
  });

  it('refuses access when there is no active enrollment (covers both "never enrolled" and "revoked/suspended")', async () => {
    const { service } = buildService(null);
    await expect(service.verifyAccess('learner-1', 'course-1')).rejects.toThrow();
    await expect(service.hasAccess('learner-1', 'course-1')).resolves.toBe(false);
  });

  it('always re-queries the live enrollment table — never caches a result across two calls', async () => {
    const { service, enrollments } = buildService({ id: 'enrollment-1' });
    await service.hasAccess('learner-1', 'course-1');
    await service.hasAccess('learner-1', 'course-1');
    expect(enrollments.getActiveEnrollment).toHaveBeenCalledTimes(2);
  });

  describe('verifyAccessByEnrollment (T125)', () => {
    it('returns the enrollment when it belongs to the learner and is active', async () => {
      const enrollment = { id: 'enrollment-1', status: 'active' };
      const { service } = buildService(null, enrollment);
      await expect(service.verifyAccessByEnrollment('learner-1', 'enrollment-1')).resolves.toBe(enrollment);
    });

    it('404s for an enrollment that does not belong to this learner (or does not exist) — never distinguishes the two (IDOR)', async () => {
      const { service } = buildService(null, null);
      await expect(service.verifyAccessByEnrollment('learner-1', 'someone-elses-enrollment')).rejects.toThrow();
    });

    it('403s for the learner\'s own enrollment when it is revoked or suspended', async () => {
      const { service } = buildService(null, { id: 'enrollment-1', status: 'revoked' });
      await expect(service.verifyAccessByEnrollment('learner-1', 'enrollment-1')).rejects.toThrow();
    });
  });
});
