import { ConflictException, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { FindOperator } from 'typeorm';

import type { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { InstructorApplicationStatus } from '../common/enums';
import { InstructorApplication } from './entities/instructor-application.entity';
import type { InstructorAccountService } from './instructor-account.service';
import { InstructorApplicationService } from './instructor-application.service';

function buildApplication(overrides: Partial<InstructorApplication> = {}): InstructorApplication {
  const now = new Date();
  return {
    id: 'app-1',
    user_id: 'user-1',
    status: InstructorApplicationStatus.DRAFT,
    display_name: 'Nour',
    headline: 'Senior Engineer',
    headline_ar: null,
    bio: 'A bio',
    bio_ar: null,
    years_of_experience: 5,
    education: [],
    certifications: [],
    work_experience: [],
    specializations: ['Backend'],
    skills: [],
    intended_category_ids: ['00000000-0000-4000-8000-000000000001'],
    portfolio_items: [],
    professional_links: [{ kind: 'linkedin', url: 'https://linkedin.com/in/nour' }],
    photo_key: 'photos/1.jpg',
    document_keys: [],
    reviewed_by: null,
    reviewed_at: null,
    decision_reason: null,
    internal_notes: null,
    submitted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as InstructorApplication;
}

/** Mirrors how Postgres evaluates a `repo.update(where, patch)` criteria object: plain equality or `In(...)`. */
function matchesCriteria(row: InstructorApplication, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = (row as unknown as Record<string, unknown>)[key];
    if (expected instanceof FindOperator) {
      return expected.type === 'in' && (expected.value as unknown[]).includes(actual);
    }
    return actual === expected;
  });
}

function buildService(rows: InstructorApplication[] = []): {
  service: InstructorApplicationService;
  applications: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
  };
  activityLogs: jest.Mocked<ActivityLogsService>;
  eventEmitter: jest.Mocked<EventEmitter2>;
} {
  const applications = {
    create: jest.fn((data: Partial<InstructorApplication>) => buildApplication(data)),
    save: jest.fn(async (entity: InstructorApplication) => entity),
    findOne: jest.fn(async ({ where }: { where: unknown }) => {
      const conditions = Array.isArray(where) ? where : [where];
      for (const condition of conditions as Array<
        Partial<InstructorApplication> & { id?: string }
      >) {
        const match = rows.find((r) =>
          Object.entries(condition).every(
            ([key, value]) => (r as unknown as Record<string, unknown>)[key] === value,
          ),
        );
        if (match) return match;
      }
      return null;
    }),
    find: jest.fn(async ({ where }: { where: Partial<InstructorApplication> }) =>
      rows.filter((r) =>
        Object.entries(where).every(
          ([key, value]) => (r as unknown as Record<string, unknown>)[key] === value,
        ),
      ),
    ),
    createQueryBuilder: jest.fn(),
    update: jest.fn(
      async (where: Record<string, unknown>, patch: Partial<InstructorApplication>) => {
        const matched = rows.filter((r) => matchesCriteria(r, where));
        for (const row of matched) Object.assign(row, patch);
        return { affected: matched.length };
      },
    ),
  };
  const activityLogs = {
    getLatestAuditRecord: jest.fn().mockResolvedValue(null),
    recordAuditEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ActivityLogsService>;
  const eventEmitter = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;
  const accounts = {
    findByEmailOrPhone: jest.fn().mockResolvedValue(null),
    resolveOrCreateAccount: jest.fn(),
    sendAccountSetupLink: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<InstructorAccountService>;

  return {
    service: new InstructorApplicationService(
      applications as never,
      accounts,
      activityLogs,
      eventEmitter,
    ),
    applications,
    accounts,
    activityLogs,
    eventEmitter,
  };
}

describe('InstructorApplicationService', () => {
  describe('createDraft', () => {
    it('creates a draft when the applicant has no open application', async () => {
      const { service, applications } = buildService([]);
      await service.createDraft('user-1', { display_name: 'Nour' });
      expect(applications.save).toHaveBeenCalled();
    });

    it('applies the empty-draft defaults even when omitted DTO fields are explicit undefined keys', async () => {
      const { service, applications } = buildService([]);
      // What ValidationPipe({ transform: true }) hands over for an empty request body.
      await service.createDraft('user-1', {
        display_name: undefined,
        years_of_experience: undefined,
      });

      const created = applications.create.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(created['display_name']).toBe('');
      expect(created['years_of_experience']).toBe(0);
      expect(created['user_id']).toBe('user-1');
      expect(created['status']).toBe(InstructorApplicationStatus.DRAFT);
    });

    it('refuses when a unique-index conflict is raised (an open application already exists, FR-015)', async () => {
      const { service, applications } = buildService([]);
      const error = new Error(
        'duplicate key value violates unique constraint "UQ_mp_applications_user_open"',
      );
      (error as unknown as { code: string }).code = '23505';
      applications.save.mockRejectedValueOnce(error);

      await expect(service.createDraft('user-1', {})).rejects.toThrow();
    });
  });

  describe('updateDraft — illegal transitions', () => {
    it.each([
      InstructorApplicationStatus.SUBMITTED,
      InstructorApplicationStatus.UNDER_REVIEW,
      InstructorApplicationStatus.APPROVED,
      InstructorApplicationStatus.WITHDRAWN,
    ])('refuses to edit an application in status %s', async (status) => {
      const { service } = buildService([buildApplication({ status })]);
      await expect(service.updateDraft('user-1', { display_name: 'X' })).rejects.toThrow();
    });

    it.each([InstructorApplicationStatus.DRAFT, InstructorApplicationStatus.REJECTED])(
      'allows editing an application in status %s',
      async (status) => {
        const { service } = buildService([buildApplication({ status })]);
        await expect(service.updateDraft('user-1', { display_name: 'X' })).resolves.toBeDefined();
      },
    );
  });

  describe('submit — FR-011 mandatory fields', () => {
    it('transitions draft to submitted when every mandatory field is present, and emits the domain event (T049)', async () => {
      const { service, eventEmitter } = buildService([
        buildApplication({ status: InstructorApplicationStatus.DRAFT }),
      ]);
      const result = await service.submit('user-1');
      expect(result.status).toBe(InstructorApplicationStatus.SUBMITTED);
      expect(result.submitted_at).toBeInstanceOf(Date);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'marketplace.application.submitted',
        expect.objectContaining({ applicationId: 'app-1', applicantUserId: 'user-1' }),
      );
    });

    it.each([
      ['display_name', { display_name: '' }],
      ['photo_key', { photo_key: null }],
      ['headline', { headline: null }],
      ['bio', { bio: null }],
      ['specializations', { specializations: [] }],
      ['intended_category_ids', { intended_category_ids: [] }],
    ])(
      'lists %s as missing and refuses submission when it is absent',
      async (fieldName, overrides) => {
        const { service } = buildService([
          buildApplication({ status: InstructorApplicationStatus.DRAFT, ...overrides }),
        ]);
        await expect(service.submit('user-1')).rejects.toMatchObject({
          response: expect.objectContaining({ details: expect.arrayContaining([fieldName]) }),
        });
      },
    );

    it('accepts zero years of experience as present (not missing)', async () => {
      const { service } = buildService([
        buildApplication({ status: InstructorApplicationStatus.DRAFT, years_of_experience: 0 }),
      ]);
      await expect(service.submit('user-1')).resolves.toBeDefined();
    });

    it('requires at least one professional link OR portfolio item, either satisfies it', async () => {
      const { service: withLink } = buildService([
        buildApplication({
          status: InstructorApplicationStatus.DRAFT,
          professional_links: [{ kind: 'linkedin', url: 'https://linkedin.com/in/x' }],
          portfolio_items: [],
        }),
      ]);
      await expect(withLink.submit('user-1')).resolves.toBeDefined();

      const { service: withPortfolio } = buildService([
        buildApplication({
          status: InstructorApplicationStatus.DRAFT,
          professional_links: [],
          portfolio_items: [{ title: 'X', url: 'https://x.com', description: null }],
        }),
      ]);
      await expect(withPortfolio.submit('user-1')).resolves.toBeDefined();

      const { service: withNeither } = buildService([
        buildApplication({
          status: InstructorApplicationStatus.DRAFT,
          professional_links: [],
          portfolio_items: [],
        }),
      ]);
      await expect(withNeither.submit('user-1')).rejects.toMatchObject({
        response: expect.objectContaining({
          details: expect.arrayContaining(['professional_links_or_portfolio_items']),
        }),
      });
    });

    it.each([
      InstructorApplicationStatus.SUBMITTED,
      InstructorApplicationStatus.UNDER_REVIEW,
      InstructorApplicationStatus.APPROVED,
      InstructorApplicationStatus.WITHDRAWN,
    ])('refuses to submit an application already in status %s', async (status) => {
      const { service } = buildService([buildApplication({ status })]);
      await expect(service.submit('user-1')).rejects.toThrow();
    });
  });

  describe('submit — FR-016 resubmission limits (rejected → submitted)', () => {
    it('refuses resubmission before the 14-day wait has elapsed', async () => {
      const reviewedAt = new Date();
      reviewedAt.setDate(reviewedAt.getDate() - 13); // one day short of 14
      const { service } = buildService([
        buildApplication({ status: InstructorApplicationStatus.REJECTED, reviewed_at: reviewedAt }),
      ]);
      await expect(service.submit('user-1')).rejects.toMatchObject({
        response: expect.objectContaining({ reason: 'wait_period' }),
      });
    });

    it('allows resubmission exactly at the 14-day boundary', async () => {
      const reviewedAt = new Date();
      reviewedAt.setDate(reviewedAt.getDate() - 14);
      reviewedAt.setMinutes(reviewedAt.getMinutes() - 1); // just past the boundary, deterministically
      const { service } = buildService([
        buildApplication({ status: InstructorApplicationStatus.REJECTED, reviewed_at: reviewedAt }),
      ]);
      await expect(service.submit('user-1')).resolves.toBeDefined();
    });

    it('allows resubmission well after the wait period', async () => {
      const reviewedAt = new Date();
      reviewedAt.setDate(reviewedAt.getDate() - 30);
      const { service } = buildService([
        buildApplication({ status: InstructorApplicationStatus.REJECTED, reviewed_at: reviewedAt }),
      ]);
      await expect(service.submit('user-1')).resolves.toBeDefined();
    });

    it('refuses the third resubmission after three total rejections', async () => {
      const old = new Date();
      old.setDate(old.getDate() - 100);
      const { service, applications } = buildService([
        buildApplication({
          id: 'app-1',
          status: InstructorApplicationStatus.REJECTED,
          reviewed_at: old,
        }),
      ]);
      // Two prior rejections already on record, plus this current (third) one.
      applications.find.mockResolvedValueOnce([
        buildApplication({
          id: 'app-1',
          status: InstructorApplicationStatus.REJECTED,
          reviewed_at: old,
        }),
        buildApplication({
          id: 'app-0',
          status: InstructorApplicationStatus.REJECTED,
          reviewed_at: old,
        }),
        buildApplication({
          id: 'app-00',
          status: InstructorApplicationStatus.REJECTED,
          reviewed_at: old,
        }),
      ]);

      await expect(service.submit('user-1')).rejects.toMatchObject({
        response: expect.objectContaining({ reason: 'attempt_limit' }),
      });
    });

    it('allows resubmission with only two prior rejections', async () => {
      const old = new Date();
      old.setDate(old.getDate() - 100);
      const { service, applications } = buildService([
        buildApplication({
          id: 'app-1',
          status: InstructorApplicationStatus.REJECTED,
          reviewed_at: old,
        }),
      ]);
      applications.find.mockResolvedValueOnce([
        buildApplication({
          id: 'app-1',
          status: InstructorApplicationStatus.REJECTED,
          reviewed_at: old,
        }),
        buildApplication({
          id: 'app-0',
          status: InstructorApplicationStatus.REJECTED,
          reviewed_at: old,
        }),
      ]);

      await expect(service.submit('user-1')).resolves.toBeDefined();
    });

    it('ignores rejections that happened before an admin reset (FR-016 re-enablement)', async () => {
      const old = new Date();
      old.setDate(old.getDate() - 100);
      const resetAt = new Date();
      resetAt.setDate(resetAt.getDate() - 50); // reset happened after the three old rejections

      const { service, applications, activityLogs } = buildService([
        buildApplication({
          id: 'app-1',
          status: InstructorApplicationStatus.REJECTED,
          reviewed_at: old,
        }),
      ]);
      applications.find.mockResolvedValueOnce([
        buildApplication({
          id: 'app-1',
          status: InstructorApplicationStatus.REJECTED,
          reviewed_at: old,
        }),
        buildApplication({
          id: 'app-0',
          status: InstructorApplicationStatus.REJECTED,
          reviewed_at: old,
        }),
        buildApplication({
          id: 'app-00',
          status: InstructorApplicationStatus.REJECTED,
          reviewed_at: old,
        }),
      ]);
      activityLogs.getLatestAuditRecord.mockResolvedValueOnce({ created_at: resetAt } as never);

      await expect(service.submit('user-1')).resolves.toBeDefined();
    });
  });

  describe('withdraw', () => {
    it.each([
      InstructorApplicationStatus.DRAFT,
      InstructorApplicationStatus.SUBMITTED,
      InstructorApplicationStatus.UNDER_REVIEW,
    ])('withdraws an application in status %s', async (status) => {
      const { service } = buildService([buildApplication({ status })]);
      const result = await service.withdraw('user-1');
      expect(result.status).toBe(InstructorApplicationStatus.WITHDRAWN);
    });

    it('refuses to withdraw an approved application', async () => {
      const { service } = buildService([
        buildApplication({ status: InstructorApplicationStatus.APPROVED }),
      ]);
      await expect(service.withdraw('user-1')).rejects.toThrow();
    });
  });

  describe('admin review transitions', () => {
    it('getDossier moves submitted to under_review as a side effect of opening it', async () => {
      const { service } = buildService([
        buildApplication({ status: InstructorApplicationStatus.SUBMITTED }),
      ]);
      const result = await service.getDossier('app-1');
      expect(result.status).toBe(InstructorApplicationStatus.UNDER_REVIEW);
    });

    it('getDossier does not change an already under_review application', async () => {
      const { service, applications } = buildService([
        buildApplication({ status: InstructorApplicationStatus.UNDER_REVIEW }),
      ]);
      const result = await service.getDossier('app-1');
      expect(result.status).toBe(InstructorApplicationStatus.UNDER_REVIEW);
      expect(applications.save).not.toHaveBeenCalled();
      await expect(applications.update.mock.results[0]?.value).resolves.toEqual({ affected: 0 });
    });

    it('getDossier never moves a decided application back to under_review', async () => {
      const { service } = buildService([
        buildApplication({ status: InstructorApplicationStatus.APPROVED }),
      ]);
      const result = await service.getDossier('app-1');
      expect(result.status).toBe(InstructorApplicationStatus.APPROVED);
    });

    it('getDossier is a 404 for an unknown id', async () => {
      const { service } = buildService([]);
      await expect(service.getDossier('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([InstructorApplicationStatus.SUBMITTED, InstructorApplicationStatus.UNDER_REVIEW])(
      'approves an application from status %s',
      async (status) => {
        const { service } = buildService([buildApplication({ status })]);
        const result = await service.markApproved('app-1', 'admin-1');
        expect(result.status).toBe(InstructorApplicationStatus.APPROVED);
        expect(result.reviewed_by).toBe('admin-1');
      },
    );

    it.each([
      InstructorApplicationStatus.DRAFT,
      InstructorApplicationStatus.APPROVED,
      InstructorApplicationStatus.REJECTED,
      InstructorApplicationStatus.WITHDRAWN,
    ])(
      'refuses to approve an application in status %s with 409 already-decided',
      async (status) => {
        const { service } = buildService([buildApplication({ status })]);
        const attempt = service.markApproved('app-1', 'admin-1');
        await expect(attempt).rejects.toBeInstanceOf(ConflictException);
        await expect(attempt).rejects.toMatchObject({
          response: { code: 'APPLICATION_ALREADY_DECIDED' },
        });
      },
    );

    it('approve and reject are 404 for an unknown id', async () => {
      const { service } = buildService([]);
      await expect(service.markApproved('missing', 'admin-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.reject('missing', 'admin-1', 'reason')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('a second decision on the same application loses with 409 and changes nothing (FR-020)', async () => {
      const row = buildApplication({ status: InstructorApplicationStatus.UNDER_REVIEW });
      const { service } = buildService([row]);
      await service.markApproved('app-1', 'admin-1');

      await expect(service.reject('app-1', 'admin-2', 'too late')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(row.status).toBe(InstructorApplicationStatus.APPROVED);
      expect(row.decision_reason).toBeNull();
      expect(row.reviewed_by).toBe('admin-1');
    });

    it('decides through one conditional update guarded on a reviewable status', async () => {
      const { service, applications } = buildService([
        buildApplication({ status: InstructorApplicationStatus.SUBMITTED }),
      ]);
      await service.reject('app-1', 'admin-1', 'Incomplete portfolio');
      const [where] = applications.update.mock.calls[0] as [Record<string, unknown>];
      expect(where['id']).toBe('app-1');
      expect(where['status']).toBeInstanceOf(FindOperator);
      expect((where['status'] as FindOperator<unknown>).value).toEqual([
        InstructorApplicationStatus.SUBMITTED,
        InstructorApplicationStatus.UNDER_REVIEW,
      ]);
      expect(applications.save).not.toHaveBeenCalled();
    });

    it('reject requires and stores a reason (FR-018)', async () => {
      const { service } = buildService([
        buildApplication({ status: InstructorApplicationStatus.SUBMITTED }),
      ]);
      const result = await service.reject('app-1', 'admin-1', 'Incomplete portfolio');
      expect(result.status).toBe(InstructorApplicationStatus.REJECTED);
      expect(result.decision_reason).toBe('Incomplete portfolio');
    });
  });

  describe('resetAttempts', () => {
    it('records an audit event for the reset (FR-016)', async () => {
      const { service, activityLogs } = buildService([]);
      await service.resetAttempts('user-1', 'admin-1', 'Circumstances changed');
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledTimes(1);
    });
  });
});
