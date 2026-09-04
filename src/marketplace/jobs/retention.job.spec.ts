import { RetentionSweepService } from './retention.job';

function buildApplication(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    display_name: 'Real Name',
    headline: 'Real headline',
    headline_ar: 'عنوان حقيقي',
    bio: 'Real bio',
    bio_ar: 'سيرة ذاتية حقيقية',
    education: [{ institution: 'X' }],
    certifications: [{ name: 'Y' }],
    work_experience: [{ company: 'Z' }],
    specializations: ['a'],
    skills: ['b'],
    portfolio_items: [{ title: 'p' }],
    professional_links: [{ kind: 'website', url: 'https://x.test' }],
    photo_key: 'photos/app-1.jpg',
    document_keys: ['docs/app-1-cert.pdf', 'docs/app-1-id.pdf'],
    internal_notes: 'secret notes',
    reviewed_at: new Date('2024-01-01T00:00:00.000Z'),
    personal_data_purged_at: null,
    ...overrides,
  };
}

describe('RetentionSweepService (T222)', () => {
  it('purges every personal field, preserves the decision record, and marks the row purged', async () => {
    const application = buildApplication();
    const applicationsRepo = {
      find: jest.fn().mockResolvedValue([application]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const storage = { delete: jest.fn().mockResolvedValue(undefined) };
    const service = new RetentionSweepService(applicationsRepo as never, storage as never);

    const result = await service.runSweep();

    expect(result).toEqual({ purged: 1, scanned: 1 });
    expect(applicationsRepo.update).toHaveBeenCalledWith(
      { id: 'app-1' },
      expect.objectContaining({
        display_name: '[redacted]',
        headline: null,
        headline_ar: null,
        bio: null,
        bio_ar: null,
        education: [],
        certifications: [],
        work_experience: [],
        specializations: [],
        skills: [],
        portfolio_items: [],
        professional_links: [],
        photo_key: null,
        document_keys: [],
        internal_notes: null,
        personal_data_purged_at: expect.any(Date),
      }),
    );
    // The decision record itself was never named in the update payload — it stays untouched.
    const [, patch] = applicationsRepo.update.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('decision_reason');
    expect(patch).not.toHaveProperty('reviewed_by');
    expect(patch).not.toHaveProperty('reviewed_at');
  });

  it('deletes every document key and the photo key from storage', async () => {
    const application = buildApplication();
    const applicationsRepo = { find: jest.fn().mockResolvedValue([application]), update: jest.fn().mockResolvedValue(undefined) };
    const storage = { delete: jest.fn().mockResolvedValue(undefined) };
    const service = new RetentionSweepService(applicationsRepo as never, storage as never);

    await service.runSweep();

    expect(storage.delete).toHaveBeenCalledWith('docs/app-1-cert.pdf');
    expect(storage.delete).toHaveBeenCalledWith('docs/app-1-id.pdf');
    expect(storage.delete).toHaveBeenCalledWith('photos/app-1.jpg');
    expect(storage.delete).toHaveBeenCalledTimes(3);
  });

  it('a storage deletion failure never aborts the sweep — the DB purge for this and later rows still completes', async () => {
    const application = buildApplication();
    const applicationsRepo = { find: jest.fn().mockResolvedValue([application]), update: jest.fn().mockResolvedValue(undefined) };
    const storage = { delete: jest.fn().mockRejectedValue(new Error('provider unreachable')) };
    const service = new RetentionSweepService(applicationsRepo as never, storage as never);

    const result = await service.runSweep();

    expect(result.purged).toBe(1);
    expect(applicationsRepo.update).toHaveBeenCalledTimes(1);
  });

  it('reports zero purged when nothing is due', async () => {
    const applicationsRepo = { find: jest.fn().mockResolvedValue([]), update: jest.fn() };
    const storage = { delete: jest.fn() };
    const service = new RetentionSweepService(applicationsRepo as never, storage as never);

    const result = await service.runSweep();

    expect(result).toEqual({ purged: 0, scanned: 0 });
    expect(applicationsRepo.update).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
