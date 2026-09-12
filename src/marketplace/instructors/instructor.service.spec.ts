import type { EventEmitter2 } from '@nestjs/event-emitter';

import type { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { MarketplaceInstructorStatus } from '../common/enums';
import { InstructorApplicationStatus } from '../common/enums';
import { InstructorApplication } from './entities/instructor-application.entity';
import { MarketplaceInstructor } from './entities/marketplace-instructor.entity';
import { InstructorService } from './instructor.service';
import type { InstructorAccountService } from './instructor-account.service';
import type { InstructorApplicationService } from './instructor-application.service';

function buildApplication(overrides: Partial<InstructorApplication> = {}): InstructorApplication {
  return {
    id: 'app-1',
    user_id: 'user-1',
    status: InstructorApplicationStatus.SUBMITTED,
    display_name: 'Nour',
    headline: 'Senior Engineer',
    bio: 'A bio',
    years_of_experience: 5,
    education: [],
    certifications: [],
    work_experience: [],
    specializations: ['Backend'],
    skills: [],
    intended_category_ids: [],
    portfolio_items: [],
    professional_links: [],
    photo_key: 'photos/1.jpg',
    ...overrides,
  } as unknown as InstructorApplication;
}

function buildInstructor(overrides: Partial<MarketplaceInstructor> = {}): MarketplaceInstructor {
  return {
    id: 'instr-1',
    user_id: 'user-1',
    status: MarketplaceInstructorStatus.APPROVED,
    display_name: 'Nour',
    ...overrides,
  } as unknown as MarketplaceInstructor;
}

function buildService(instructorRow: MarketplaceInstructor | null, applicationRow: InstructorApplication | null) {
  const instructors = {
    findOne: jest.fn().mockResolvedValue(instructorRow),
    save: jest.fn(async (entity: MarketplaceInstructor) => entity),
  };
  const applicationService = {
    markApprovedWithManager: jest.fn(async (_manager: unknown, _id: string, adminId: string) => ({
      ...applicationRow,
      status: InstructorApplicationStatus.APPROVED,
      reviewed_by: adminId,
    })),
    reject: jest.fn(async () => applicationRow),
  } as unknown as jest.Mocked<InstructorApplicationService>;
  const activityLogs = {
    recordAuditEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ActivityLogsService>;
  const accounts = {
    resolveOrCreateAccount: jest.fn(),
    sendAccountSetupLink: jest.fn().mockResolvedValue(undefined),
    findByEmailOrPhone: jest.fn().mockResolvedValue(null),
  } as unknown as jest.Mocked<InstructorAccountService>;
  const eventEmitter = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;
  const applications = {
    save: jest.fn(async (entity: InstructorApplication) => entity),
  };
  const manager = {
    create: jest.fn((_entity: unknown, data: Partial<MarketplaceInstructor>) => data as MarketplaceInstructor),
    save: jest.fn(async (entity: MarketplaceInstructor) => ({ ...entity, id: 'instr-new' })),
    getRepository: jest.fn(() => applications),
  };
  const dataSource = {
    transaction: jest.fn(async (isolationOrFn: unknown, maybeFn?: unknown) => {
      const fn = (typeof isolationOrFn === 'function' ? isolationOrFn : maybeFn) as (m: unknown) => Promise<unknown>;
      return fn(manager);
    }),
  };

  const service = new InstructorService(
    instructors as never,
    applicationService,
    accounts,
    activityLogs,
    dataSource as never,
    eventEmitter,
  );
  return { service, instructors, applicationService, accounts, activityLogs, eventEmitter, manager };
}

describe('InstructorService', () => {
  describe('approveApplication', () => {
    it('creates the capability record from the approved application, in the same transaction, with users.role never read or written (FR-009, Q2)', async () => {
      const application = buildApplication();
      const { service, manager, accounts, activityLogs, eventEmitter } = buildService(null, application);

      const result = await service.approveApplication('app-1', 'admin-1');

      expect(manager.create).toHaveBeenCalledWith(
        MarketplaceInstructor,
        expect.objectContaining({
          user_id: 'user-1',
          application_id: 'app-1',
          status: MarketplaceInstructorStatus.APPROVED,
          display_name: 'Nour',
          approved_by: 'admin-1',
        }),
      );
      expect(manager.save).toHaveBeenCalled();
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.application.approved',
        expect.objectContaining({ applicationId: 'app-1', applicantUserId: 'user-1', instructorId: 'instr-new' }),
      );
      expect(result.id).toBe('instr-new');

      // The capability record itself carries no role field, and an applicant
      // who already has an account must not send approval anywhere near the
      // `users` table: provisioning is the only thing that touches it, and
      // this path skips provisioning entirely.
      const createdRow = manager.create.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(createdRow).not.toHaveProperty('role');
      expect(manager.getRepository).not.toHaveBeenCalled();
      expect(accounts.resolveOrCreateAccount).not.toHaveBeenCalled();
      expect(accounts.sendAccountSetupLink).not.toHaveBeenCalled();
    });

    it('generates a slug from the display name', async () => {
      const { service, manager } = buildService(null, buildApplication({ display_name: 'Nour Ahmed' }));
      await service.approveApplication('app-1', 'admin-1');
      const created = manager.create.mock.calls[0]?.[1] as { slug: string };
      expect(created.slug).toMatch(/^nour-ahmed-[0-9a-f]{6}$/);
    });
  });

  describe('rejectApplication', () => {
    it('delegates to the application service and records an audit event plus the domain event', async () => {
      const { service, applicationService, activityLogs, eventEmitter } = buildService(null, buildApplication());
      await service.rejectApplication('app-1', 'admin-1', 'Incomplete portfolio');
      expect(applicationService.reject).toHaveBeenCalledWith('app-1', 'admin-1', 'Incomplete portfolio');
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.application.rejected',
        expect.objectContaining({ applicationId: 'app-1', applicantUserId: 'user-1', reason: 'Incomplete portfolio' }),
      );
    });
  });

  describe('suspend', () => {
    it('sets suspension fields and records an audit event, touching nothing else (FR-022, FR-023)', async () => {
      const { service, instructors, activityLogs, eventEmitter } = buildService(buildInstructor(), null);
      const result = await service.suspend('instr-1', 'admin-1', 'Policy violation');

      expect(result.status).toBe(MarketplaceInstructorStatus.SUSPENDED);
      expect(result.suspension_reason).toBe('Policy violation');
      expect(result.suspended_by).toBe('admin-1');
      expect(instructors.save).toHaveBeenCalledTimes(1);
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.instructor.suspended',
        expect.objectContaining({ instructorId: 'instr-1', userId: 'user-1', reason: 'Policy violation' }),
      );
    });

    it('refuses when the instructor does not exist', async () => {
      const { service } = buildService(null, null);
      await expect(service.suspend('instr-1', 'admin-1', 'reason')).rejects.toThrow();
    });
  });

  describe('reinstate', () => {
    it('returns a suspended instructor to approved and clears suspension fields', async () => {
      const { service, activityLogs, eventEmitter } = buildService(
        buildInstructor({
          status: MarketplaceInstructorStatus.SUSPENDED,
          suspension_reason: 'old reason',
          suspended_at: new Date(),
          suspended_by: 'admin-0',
        }),
        null,
      );
      const result = await service.reinstate('instr-1', 'admin-1');

      expect(result.status).toBe(MarketplaceInstructorStatus.APPROVED);
      expect(result.suspension_reason).toBeNull();
      expect(result.suspended_at).toBeNull();
      expect(result.suspended_by).toBeNull();
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.instructor.reinstated',
        expect.objectContaining({ instructorId: 'instr-1', userId: 'user-1' }),
      );
    });

    it('refuses to reinstate an instructor who is not currently suspended', async () => {
      const { service } = buildService(buildInstructor({ status: MarketplaceInstructorStatus.APPROVED }), null);
      await expect(service.reinstate('instr-1', 'admin-1')).rejects.toThrow();
    });
  });
});
