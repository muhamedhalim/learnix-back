import type { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';

import type { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { Reflector } from '@nestjs/core';

import { RolesGuard } from '../../auth/guards/roles.guard';
import type { MailService } from '../../mail/mail.service';
import { UserStatus } from '../../users/entities/user-status.enum';
import { InstructorApplicationStatus, MarketplaceInstructorStatus } from '../common/enums';
import { InstructorApplication } from './entities/instructor-application.entity';
import { MarketplaceInstructor } from './entities/marketplace-instructor.entity';
import { InstructorAccountService } from './instructor-account.service';
import { InstructorApplicationService } from './instructor-application.service';
import type { InstructorService as InstructorServiceType } from './instructor.service';
import { InstructorService } from './instructor.service';

/**
 * The independent instructor entry path: a person with no platform account
 * applies, an admin approves, and only then is an account provisioned — with
 * no academic role, no academic profile, and no academic approval step.
 *
 * These tests exist to keep that independence honest. An earlier iteration
 * required an applicant to first register as a student or teacher and be
 * approved into the academic lifecycle before they could even apply.
 */

/** A complete application body, so FR-011's mandatory set is satisfied. */
const COMPLETE_FIELDS = {
  display_name: 'Nour Ahmed',
  headline: 'Senior Engineer',
  bio: 'Fifteen years of backend work.',
  years_of_experience: 12,
  specializations: ['Backend'],
  intended_category_ids: ['00000000-0000-4000-8000-000000000001'],
  professional_links: [{ kind: 'linkedin' as const, url: 'https://linkedin.com/in/nour' }],
};

function buildApplicationService(existingAccount: unknown = null) {
  const applications = {
    create: jest.fn((data: Partial<InstructorApplication>) => ({ id: 'app-new', ...data })),
    save: jest.fn(async (entity: InstructorApplication) => entity),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
  };
  const accounts = {
    findByEmailOrPhone: jest.fn().mockResolvedValue(existingAccount),
    resolveOrCreateAccount: jest.fn(),
    sendAccountSetupLink: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<InstructorAccountService>;
  const activityLogs = {
    getLatestAuditRecord: jest.fn().mockResolvedValue(null),
    recordAuditEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ActivityLogsService>;
  const eventEmitter = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;

  const service = new InstructorApplicationService(
    applications as never,
    accounts,
    activityLogs,
    eventEmitter,
  );
  return { service, applications, accounts, eventEmitter };
}

describe('public instructor application (no account required)', () => {
  it('stores the application with no user, no role and no academic profile', async () => {
    const { service, applications, eventEmitter } = buildApplicationService();

    const saved = await service.submitPublic(
      { email: '  Nour@Example.COM ', phone: '01011111111' },
      { ...COMPLETE_FIELDS },
    );

    const created = applications.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(created.user_id).toBeNull();
    // Canonicalised for the unique index and the later account lookup.
    expect(created.applicant_email).toBe('nour@example.com');
    expect(created.applicant_phone).toBe('01011111111');
    // Applying must never request or grant an academic role or status.
    expect(created).not.toHaveProperty('role');
    expect(created).not.toHaveProperty('password');
    expect(created.status).toBe(InstructorApplicationStatus.SUBMITTED);
    expect(created.submitted_at).toBeInstanceOf(Date);

    expect(saved.id).toBe('app-new');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'marketplace.application.submitted',
      expect.objectContaining({ applicationId: 'app-new', applicantUserId: null }),
    );
  });

  it('refuses when the contact details already belong to an account', async () => {
    const { service, applications } = buildApplicationService({ id: 'user-9' });

    await expect(
      service.submitPublic(
        { email: 'taken@example.com', phone: '01022222222' },
        { ...COMPLETE_FIELDS },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ACCOUNT_ALREADY_EXISTS_FOR_APPLICANT' }),
    });

    // One person, one account: no shadow identity is written.
    expect(applications.save).not.toHaveBeenCalled();
  });

  it('does not require a photo from someone who cannot upload one yet, and refuses a URL in its place (MP-10)', async () => {
    const { service, applications } = buildApplicationService();
    await expect(
      service.submitPublic({ email: 'nour@example.com', phone: '01011111111' }, { ...COMPLETE_FIELDS }),
    ).resolves.toBeDefined();
    expect(applications.save).toHaveBeenCalledTimes(1);

    await expect(
      service.submitPublic(
        { email: 'other@example.com', phone: '01022222222' },
        { ...COMPLETE_FIELDS, photo_key: 'https://tracker.example/p.gif' },
      ),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INVALID_IMAGE_REFERENCE' }) });
    expect(applications.save).toHaveBeenCalledTimes(1);
  });

  it('enforces FR-011 and names each missing field instead of storing a stub', async () => {
    const { service, applications } = buildApplicationService();

    await expect(
      service.submitPublic(
        { email: 'nour@example.com', phone: '01011111111' },
        { display_name: 'Nour' },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'APPLICATION_NOT_READY_FOR_SUBMISSION',
        details: expect.arrayContaining(['headline', 'bio']),
      }),
    });

    expect(applications.save).not.toHaveBeenCalled();
  });
});

function buildAccountService() {
  const users = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((data: Record<string, unknown>) => data),
    save: jest.fn(async (entity: Record<string, unknown>) => ({ id: 'user-new', ...entity })),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const manager = { getRepository: jest.fn(() => users) };
  const configService = { get: jest.fn(() => undefined) } as unknown as jest.Mocked<ConfigService>;
  const mailService = {
    sendInvitationEmail: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<MailService>;

  const service = new InstructorAccountService(users as never, configService, mailService);
  return { service, users, manager, mailService };
}

function applicationRow(overrides: Partial<InstructorApplication> = {}): InstructorApplication {
  return {
    id: 'app-1',
    user_id: null,
    applicant_email: 'nour@example.com',
    applicant_phone: '01011111111',
    display_name: 'Nour Ahmed',
    ...overrides,
  } as InstructorApplication;
}

describe('provisioning the account behind an approved public application', () => {
  it('creates an identity with no academic role, no password and no pending review', async () => {
    const { service, users, manager } = buildAccountService();

    const { user, created } = await service.resolveOrCreateAccount(
      manager as never,
      applicationRow(),
    );

    expect(created).toBe(true);
    const written = users.create.mock.calls[0]?.[0] as Record<string, unknown>;
    // The whole point: not a student, not a teacher, not pending academic approval.
    expect(written.role).toBeNull();
    expect(written.password_hash).toBeNull();
    expect(written.status).toBe(UserStatus.APPROVED);
    expect(written.email).toBe('nour@example.com');
    expect(user.id).toBe('user-new');
  });

  it('links an account the applicant created in the meantime instead of duplicating them', async () => {
    const { service, users, manager } = buildAccountService();
    users.findOne.mockResolvedValueOnce({ id: 'user-existing', email: 'nour@example.com' });

    const { user, created } = await service.resolveOrCreateAccount(
      manager as never,
      applicationRow(),
    );

    expect(created).toBe(false);
    expect(user.id).toBe('user-existing');
    expect(users.save).not.toHaveBeenCalled();
  });

  it('refuses to take over a phone number that belongs to someone else', async () => {
    const { service, users, manager } = buildAccountService();
    users.findOne
      .mockResolvedValueOnce(null) // no account for the email
      .mockResolvedValueOnce({ id: 'someone-else' }); // but the phone is taken

    await expect(
      service.resolveOrCreateAccount(manager as never, applicationRow()),
    ).rejects.toThrow(/phone number already belongs/i);
    expect(users.save).not.toHaveBeenCalled();
  });

  it('issues a setup link through the existing reset-password machinery', async () => {
    const { service, users, mailService } = buildAccountService();

    await service.sendAccountSetupLink({
      id: 'user-new',
      email: 'nour@example.com',
      name: 'Nour Ahmed',
      preferred_language: null,
    } as never);

    // Same three columns the forgot-password flow writes, so the existing
    // reset-password endpoint accepts the link unchanged.
    const patch = users.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.password_reset_token).toEqual(expect.any(String));
    expect(patch.password_reset_token_id).toHaveLength(64);
    expect(patch.password_reset_expires_at).toBeInstanceOf(Date);

    const email = mailService.sendInvitationEmail.mock.calls[0]?.[0];
    expect(email?.to).toBe('nour@example.com');
    expect(String(email?.personalization?.['setupUrl'])).toContain('/auth/reset-password?token=');
  });
});

describe('approving a public application', () => {
  function buildApprovalService(application: InstructorApplication) {
    const instructors = { findOne: jest.fn(), save: jest.fn() };
    const applicationService = {
      markApprovedWithManager: jest.fn(async () => application),
    } as unknown as jest.Mocked<InstructorApplicationService>;
    const provisioned = { id: 'user-new', email: 'nour@example.com', name: 'Nour Ahmed' };
    const accounts = {
      resolveOrCreateAccount: jest.fn().mockResolvedValue({ user: provisioned, created: true }),
      sendAccountSetupLink: jest.fn().mockResolvedValue(undefined),
      findByEmailOrPhone: jest.fn(),
    } as unknown as jest.Mocked<InstructorAccountService>;
    const activityLogs = {
      recordAuditEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ActivityLogsService>;
    const eventEmitter = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;
    const applicationsRepo = { save: jest.fn(async (row: unknown) => row) };
    const manager = {
      create: jest.fn((_entity: unknown, data: Partial<MarketplaceInstructor>) => data),
      save: jest.fn(async (entity: Partial<MarketplaceInstructor>) => ({
        ...entity,
        id: 'instr-new',
      })),
      getRepository: jest.fn(() => applicationsRepo),
    };
    const dataSource = {
      transaction: jest.fn(async (isolationOrFn: unknown, maybeFn?: unknown) => {
        const fn = (typeof isolationOrFn === 'function' ? isolationOrFn : maybeFn) as (
          m: unknown,
        ) => Promise<unknown>;
        return fn(manager);
      }),
    };

    const service: InstructorServiceType = new InstructorService(
      instructors as never,
      applicationService,
      accounts,
      activityLogs,
      dataSource as never,
      eventEmitter,
    );
    return { service, accounts, manager, applicationsRepo, eventEmitter };
  }

  it('provisions the account, links it to the application and grants the capability', async () => {
    const application = applicationRow();
    const { service, accounts, manager, applicationsRepo, eventEmitter } =
      buildApprovalService(application);

    const instructor = await service.approveApplication('app-1', 'admin-1');

    expect(accounts.resolveOrCreateAccount).toHaveBeenCalledWith(manager, application);
    // The application now points at the provisioned identity...
    expect(application.user_id).toBe('user-new');
    expect(applicationsRepo.save).toHaveBeenCalledWith(application);
    // ...and the capability row is keyed on it, in the same transaction.
    const capability = manager.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(capability.user_id).toBe('user-new');
    expect(capability.status).toBe(MarketplaceInstructorStatus.APPROVED);
    expect(capability).not.toHaveProperty('role');
    expect(instructor.id).toBe('instr-new');

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'marketplace.application.approved',
      expect.objectContaining({ applicantUserId: 'user-new' }),
    );
    // Only a brand-new account needs to choose a password.
    expect(accounts.sendAccountSetupLink).toHaveBeenCalledTimes(1);
  });

  it('does not email a setup link to an applicant who already had an account', async () => {
    const application = applicationRow();
    const { service, accounts } = buildApprovalService(application);
    (accounts.resolveOrCreateAccount as jest.Mock).mockResolvedValue({
      user: { id: 'user-existing' },
      created: false,
    });

    await service.approveApplication('app-1', 'admin-1');

    expect(accounts.sendAccountSetupLink).not.toHaveBeenCalled();
  });
});

describe('academic isolation of a marketplace-only identity', () => {
  it('denies a null-role principal every @Roles()-protected academic route', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['student', 'teacher', 'admin']);
    const guard = new RolesGuard(reflector);

    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user: { userId: 'u1', role: null } }) }),
    };

    expect(guard.canActivate(context as never)).toBe(false);
  });
});
