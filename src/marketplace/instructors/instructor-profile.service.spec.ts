import type { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import type { MarketplaceInstructor, PendingProfileChange } from './entities/marketplace-instructor.entity';
import { InstructorProfileService } from './instructor-profile.service';

function buildInstructor(overrides: Partial<MarketplaceInstructor> = {}): MarketplaceInstructor {
  return {
    id: 'instr-1',
    user_id: 'user-1',
    display_name: 'Nour',
    headline: 'Senior Engineer',
    bio: 'A bio',
    skills: ['typescript'],
    specializations: ['Backend'],
    teaching_category_ids: ['cat-1'],
    years_of_experience: 5,
    pending_profile_changes: null,
    ...overrides,
  } as unknown as MarketplaceInstructor;
}

function buildService(instructorRow: MarketplaceInstructor | null) {
  const instructors = {
    findOne: jest.fn().mockResolvedValue(instructorRow),
    save: jest.fn(async (entity: MarketplaceInstructor) => entity),
  };
  const activityLogs = {
    recordAuditEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ActivityLogsService>;

  const service = new InstructorProfileService(instructors as never, activityLogs);
  return { service, instructors, activityLogs };
}

describe('InstructorProfileService', () => {
  describe('getProfile', () => {
    it('returns the instructor row for the given user', async () => {
      const instructor = buildInstructor();
      const { service } = buildService(instructor);
      await expect(service.getProfile('user-1')).resolves.toBe(instructor);
    });

    it('refuses when no instructor row exists for the user', async () => {
      const { service } = buildService(null);
      await expect(service.getProfile('user-1')).rejects.toThrow();
    });
  });

  describe('updateProfile — immediate-effect fields (FR-029 catch-all)', () => {
    it('applies skills, specialisations and teaching categories straight to the live row', async () => {
      const { service, instructors } = buildService(buildInstructor());
      const result = await service.updateProfile('user-1', {
        skills: ['python'],
        specializations: ['AI'],
        teaching_category_ids: ['cat-2'],
      });

      expect(result.skills).toEqual(['python']);
      expect(result.specializations).toEqual(['AI']);
      expect(result.teaching_category_ids).toEqual(['cat-2']);
      expect(result.pending_profile_changes).toBeNull();
      expect(instructors.save).toHaveBeenCalledTimes(1);
    });

    it('applies years_of_experience immediately, since it is absent from the FR-029 review-required set', async () => {
      const { service } = buildService(buildInstructor({ years_of_experience: 5 }));
      const result = await service.updateProfile('user-1', { years_of_experience: 9 });
      expect(result.years_of_experience).toBe(9);
      expect(result.pending_profile_changes).toBeNull();
    });
  });

  describe('updateProfile — review-required fields (FR-029)', () => {
    it('queues the edit in pending_profile_changes and leaves the live value untouched', async () => {
      const { service } = buildService(buildInstructor({ display_name: 'Nour', headline: 'Senior Engineer' }));
      const result = await service.updateProfile('user-1', { display_name: 'Nour Ahmed' });

      expect(result.display_name).toBe('Nour');
      expect(result.pending_profile_changes).toEqual([
        expect.objectContaining({ field: 'display_name', previous_value: 'Nour', proposed_value: 'Nour Ahmed' }),
      ]);
    });

    it('queues nothing when a whole untouched form is saved, with empty strings for the null optional fields', async () => {
      const instructor = buildInstructor({
        display_name: 'Nour',
        headline: 'Senior Engineer',
        photo_key: null,
        headline_ar: null,
        bio_ar: null,
        education: [],
      } as never);
      const { service } = buildService(instructor);
      const result = await service.updateProfile('user-1', {
        display_name: 'Nour',
        headline: 'Senior Engineer',
        photo_key: '',
        headline_ar: '',
        bio_ar: '',
        education: [],
      } as never);

      expect(result.pending_profile_changes).toBeNull();
    });

    it('still queues a real change next to untouched empty fields', async () => {
      const instructor = buildInstructor({ photo_key: null, headline_ar: null } as never);
      const { service } = buildService(instructor);
      const result = await service.updateProfile('user-1', { photo_key: '', headline_ar: '', headline: 'Staff Engineer' } as never);

      expect(result.pending_profile_changes).toEqual([
        expect.objectContaining({ field: 'headline', previous_value: 'Senior Engineer', proposed_value: 'Staff Engineer' }),
      ]);
    });

    it('re-editing an already-pending field updates the proposal but keeps previous_value pinned to the live value', async () => {
      const instructor = buildInstructor({
        display_name: 'Nour',
        pending_profile_changes: [
          { field: 'display_name', previous_value: 'Nour', proposed_value: 'Noura', requested_at: '2026-01-01T00:00:00.000Z' },
        ],
      });
      const { service } = buildService(instructor);
      const result = await service.updateProfile('user-1', { display_name: 'Noura Ahmed' });

      expect(result.display_name).toBe('Nour');
      expect(result.pending_profile_changes).toHaveLength(1);
      expect(result.pending_profile_changes?.[0]).toMatchObject({
        field: 'display_name',
        previous_value: 'Nour',
        proposed_value: 'Noura Ahmed',
      });
    });

    it('proposing the field back to its current live value clears the pending entry instead of queuing a no-op', async () => {
      const instructor = buildInstructor({
        display_name: 'Nour',
        pending_profile_changes: [
          { field: 'display_name', previous_value: 'Nour', proposed_value: 'Noura', requested_at: '2026-01-01T00:00:00.000Z' },
        ],
      });
      const { service } = buildService(instructor);
      const result = await service.updateProfile('user-1', { display_name: 'Nour' });

      expect(result.pending_profile_changes).toBeNull();
    });

    it('keeps other pending fields when only one is reverted', async () => {
      const instructor = buildInstructor({
        display_name: 'Nour',
        headline: 'Senior Engineer',
        pending_profile_changes: [
          { field: 'display_name', previous_value: 'Nour', proposed_value: 'Noura', requested_at: '2026-01-01T00:00:00.000Z' },
          { field: 'headline', previous_value: 'Senior Engineer', proposed_value: 'Staff Engineer', requested_at: '2026-01-01T00:00:00.000Z' },
        ],
      });
      const { service } = buildService(instructor);
      const result = await service.updateProfile('user-1', { display_name: 'Nour' });

      expect(result.pending_profile_changes).toEqual([
        expect.objectContaining({ field: 'headline', proposed_value: 'Staff Engineer' }),
      ]);
    });

    it('queues nested-collection edits (portfolio_items) by reference to the field name, not a deep merge', async () => {
      const { service } = buildService(buildInstructor({ portfolio_items: [] }));
      const items = [{ title: 'Project', url: 'https://example.com', description: null }];
      const result = await service.updateProfile('user-1', { portfolio_items: items });

      expect(result.portfolio_items).toEqual([]);
      expect(result.pending_profile_changes?.[0]).toMatchObject({ field: 'portfolio_items', proposed_value: items });
    });
  });

  describe('updateProfile — mixed edit', () => {
    it('applies immediate fields and queues review-required fields in the same call', async () => {
      const { service } = buildService(buildInstructor({ display_name: 'Nour', skills: ['typescript'] }));
      const result = await service.updateProfile('user-1', { display_name: 'Nour Ahmed', skills: ['python'] });

      expect(result.skills).toEqual(['python']);
      expect(result.display_name).toBe('Nour');
      expect(result.pending_profile_changes).toHaveLength(1);
      expect(result.pending_profile_changes?.[0]).toMatchObject({ field: 'display_name' });
    });
  });

  describe('approvePendingChanges', () => {
    it('applies every queued field and clears the queue, recording one audit event', async () => {
      const pending: PendingProfileChange[] = [
        { field: 'display_name', previous_value: 'Nour', proposed_value: 'Nour Ahmed', requested_at: '2026-01-01T00:00:00.000Z' },
        { field: 'headline', previous_value: 'Senior Engineer', proposed_value: 'Staff Engineer', requested_at: '2026-01-01T00:00:00.000Z' },
      ];
      const instructor = buildInstructor({ display_name: 'Nour', headline: 'Senior Engineer', pending_profile_changes: pending });
      const { service, activityLogs } = buildService(instructor);

      const result = await service.approvePendingChanges('instr-1', 'admin-1');

      expect(result.display_name).toBe('Nour Ahmed');
      expect(result.headline).toBe('Staff Engineer');
      expect(result.pending_profile_changes).toBeNull();
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledTimes(1);
    });

    it('refuses when there is nothing pending', async () => {
      const { service } = buildService(buildInstructor({ pending_profile_changes: null }));
      await expect(service.approvePendingChanges('instr-1', 'admin-1')).rejects.toThrow();
    });
  });

  describe('rejectPendingChanges', () => {
    it('discards the queue without touching the live values, recording one audit event with the reason', async () => {
      const pending: PendingProfileChange[] = [
        { field: 'display_name', previous_value: 'Nour', proposed_value: 'Nour Ahmed', requested_at: '2026-01-01T00:00:00.000Z' },
      ];
      const instructor = buildInstructor({ display_name: 'Nour', pending_profile_changes: pending });
      const { service, activityLogs } = buildService(instructor);

      const result = await service.rejectPendingChanges('instr-1', 'admin-1', 'Unverifiable claim');

      expect(result.display_name).toBe('Nour');
      expect(result.pending_profile_changes).toBeNull();
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ decision: 'rejected', reason: 'Unverifiable claim' }),
        }),
      );
    });

    it('refuses when there is nothing pending', async () => {
      const { service } = buildService(buildInstructor({ pending_profile_changes: null }));
      await expect(service.rejectPendingChanges('instr-1', 'admin-1', 'reason')).rejects.toThrow();
    });
  });
});
