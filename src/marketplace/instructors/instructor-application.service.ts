import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { EntityManager } from 'typeorm';
import { Repository } from 'typeorm';

import { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { getMarketplaceConfig } from '../../config/marketplace.config';
import { biBody } from '../../i18n/error-translator.util';
import { InstructorApplicationStatus } from '../common/enums';
import {
  accountAlreadyExistsForApplicant,
  applicationAlreadyOpen,
  applicationNotReadyForSubmission,
  applicationResubmissionBlocked,
} from '../common/errors';
import { MarketplaceApplicationAttemptsResetEvent } from '../events/audit.events';
import { MarketplaceApplicationSubmittedEvent } from '../events/domain.events';
import type {
  ApplicationCertificationEntry,
  ApplicationEducationEntry,
  ApplicationPortfolioItem,
  ApplicationProfessionalLink,
  ApplicationWorkExperienceEntry,
} from './entities/instructor-application.entity';
import { InstructorApplication } from './entities/instructor-application.entity';
import { InstructorAccountService } from './instructor-account.service';

const RESET_ATTEMPTS_ACTION = 'marketplace_application_attempts_reset';
const RESET_ATTEMPTS_TARGET_TYPE = 'marketplace_applicant';

/** Statuses in which an application is still "open" — blocks a second draft (FR-015). */
const OPEN_STATUSES = [
  InstructorApplicationStatus.DRAFT,
  InstructorApplicationStatus.SUBMITTED,
  InstructorApplicationStatus.UNDER_REVIEW,
  InstructorApplicationStatus.APPROVED,
];

const POSTGRES_UNIQUE_VIOLATION = '23505';

export interface UpdateApplicationFields {
  display_name?: string;
  photo_key?: string;
  headline?: string;
  headline_ar?: string;
  bio?: string;
  bio_ar?: string;
  years_of_experience?: number;
  education?: ApplicationEducationEntry[];
  certifications?: ApplicationCertificationEntry[];
  work_experience?: ApplicationWorkExperienceEntry[];
  specializations?: string[];
  skills?: string[];
  intended_category_ids?: string[];
  portfolio_items?: ApplicationPortfolioItem[];
  professional_links?: ApplicationProfessionalLink[];
}

export interface ApplicationQueueFilter {
  status?: InstructorApplicationStatus;
  page?: number;
  limit?: number;
}

/**
 * FR-009 – FR-024's application state machine (data-model.md §6):
 * `draft → submitted → under_review → approved` (terminal);
 * `under_review → rejected → submitted` (after edit); `draft/submitted → withdrawn`.
 */
@Injectable()
export class InstructorApplicationService {
  constructor(
    @InjectRepository(InstructorApplication)
    private readonly applications: Repository<InstructorApplication>,
    private readonly accounts: InstructorAccountService,
    private readonly activityLogs: ActivityLogsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  public async getMine(userId: string): Promise<InstructorApplication | null> {
    return this.applications.findOne({
      where: OPEN_STATUSES.map((status) => ({ user_id: userId, status })),
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Submits an application from someone who has no platform account at all.
   *
   * This is the entry point that makes instructor access independent of the
   * academic systems: it never touches `AuthService.register`, never creates a
   * student or teacher profile, and never assigns an academic role. The row is
   * stored with `user_id = null` plus contact details, and goes straight to
   * `submitted` — there is no anonymous draft to come back and edit, because
   * there is no one to authenticate as the owner of it.
   *
   * The account itself is provisioned only if an admin approves
   * (`InstructorService.approveApplication` → `InstructorAccountService`), so
   * a rejected public application leaves no account behind.
   */
  public async submitPublic(
    contact: { email: string; phone: string },
    fields: UpdateApplicationFields,
  ): Promise<InstructorApplication> {
    const email = contact.email.trim().toLowerCase();
    const phone = contact.phone.trim();

    // Someone who can already sign in must apply as themselves, so one person
    // never ends up with two identities.
    const existing = await this.accounts.findByEmailOrPhone(email, phone);
    if (existing !== null) {
      throw accountAlreadyExistsForApplicant();
    }

    const application = this.applications.create({
      user_id: null,
      applicant_email: email,
      applicant_phone: phone,
      status: InstructorApplicationStatus.SUBMITTED,
      submitted_at: new Date(),
      display_name: fields.display_name ?? '',
      years_of_experience: fields.years_of_experience ?? 0,
      ...fields,
    });

    // FR-011's mandatory set, enforced at submission exactly as for a
    // signed-in applicant — a public application has no draft stage in which
    // it could legitimately be incomplete.
    const missing = this.missingMandatoryFields(application);
    if (missing.length > 0) {
      throw applicationNotReadyForSubmission(missing);
    }

    let saved: InstructorApplication;
    try {
      saved = await this.applications.save(application);
    } catch (error) {
      const dbError = error as { code?: string };
      if (dbError.code === POSTGRES_UNIQUE_VIOLATION) {
        throw applicationAlreadyOpen();
      }
      throw error;
    }

    this.eventEmitter.emit(
      MarketplaceApplicationSubmittedEvent.EVENT_NAME,
      new MarketplaceApplicationSubmittedEvent(saved.id, saved.user_id),
    );
    return saved;
  }

  /** Creates a new draft. Refuses if an open application already exists, or if resubmission is currently blocked. */
  public async createDraft(
    userId: string,
    fields: UpdateApplicationFields,
  ): Promise<InstructorApplication> {
    await this.assertResubmissionAllowed(userId);
    try {
      // `fields` is a validated DTO instance, whose omitted optional properties are own keys holding
      // `undefined`. Spreading it first lets the explicit values below win; spreading it last used to
      // overwrite the `display_name`/`years_of_experience` defaults with `undefined` and made an
      // empty-body POST fail on a NOT NULL constraint (500).
      const draft = this.applications.create({
        ...fields,
        user_id: userId,
        status: InstructorApplicationStatus.DRAFT,
        display_name: fields.display_name ?? '',
        years_of_experience: fields.years_of_experience ?? 0,
      });
      return await this.applications.save(draft);
    } catch (error) {
      const dbError = error as { code?: string };
      if (dbError.code === POSTGRES_UNIQUE_VIOLATION) {
        throw applicationAlreadyOpen();
      }
      throw error;
    }
  }

  /** Edits while `draft` or `rejected` only (contracts §2). */
  public async updateDraft(
    userId: string,
    fields: UpdateApplicationFields,
  ): Promise<InstructorApplication> {
    const application = await this.getEditable(userId);
    Object.assign(application, fields);
    return this.applications.save(application);
  }

  /**
   * `draft → submitted` or `rejected → submitted`. FR-011's mandatory set is
   * enforced here, not at the DTO layer, since a draft is allowed to be
   * incomplete. The `rejected → submitted` path additionally re-runs the
   * FR-016 resubmission check — the same one `createDraft` already applied
   * when this application was first opened, re-verified because time has
   * passed since then.
   */
  public async submit(userId: string): Promise<InstructorApplication> {
    const application = await this.getEditable(userId);

    const missing = this.missingMandatoryFields(application);
    if (missing.length > 0) {
      throw applicationNotReadyForSubmission(missing);
    }

    if (application.status === InstructorApplicationStatus.REJECTED) {
      await this.assertResubmissionAllowed(userId);
    }

    application.status = InstructorApplicationStatus.SUBMITTED;
    application.submitted_at = new Date();
    const saved = await this.applications.save(application);

    this.eventEmitter.emit(
      MarketplaceApplicationSubmittedEvent.EVENT_NAME,
      new MarketplaceApplicationSubmittedEvent(saved.id, saved.user_id),
    );
    return saved;
  }

  /** `draft/submitted/under_review → withdrawn`. */
  public async withdraw(userId: string): Promise<InstructorApplication> {
    const application = await this.applications.findOne({
      where: OPEN_STATUSES.filter((s) => s !== InstructorApplicationStatus.APPROVED).map(
        (status) => ({
          user_id: userId,
          status,
        }),
      ),
    });
    if (!application) {
      throw new NotFoundException(
        biBody('No withdrawable application found', 'لا يوجد طلب قابل للسحب'),
      );
    }
    application.status = InstructorApplicationStatus.WITHDRAWN;
    return this.applications.save(application);
  }

  // ---------------------------------------------------------------- admin

  public async listQueue(
    filter: ApplicationQueueFilter,
  ): Promise<{ items: InstructorApplication[]; total: number }> {
    const page = filter.page ?? 1;
    const limit = Math.min(filter.limit ?? 20, 100);
    const qb = this.applications.createQueryBuilder('a').orderBy('a.submitted_at', 'ASC');
    if (filter.status) qb.andWhere('a.status = :status', { status: filter.status });
    else
      qb.andWhere('a.status IN (:...statuses)', {
        statuses: [InstructorApplicationStatus.SUBMITTED, InstructorApplicationStatus.UNDER_REVIEW],
      });
    qb.skip((page - 1) * limit).take(limit);
    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  /** Opening the dossier is what starts review — `submitted → under_review`. */
  public async getDossier(id: string): Promise<InstructorApplication> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) {
      throw new NotFoundException(biBody('Application not found', 'الطلب غير موجود'));
    }
    if (application.status === InstructorApplicationStatus.SUBMITTED) {
      application.status = InstructorApplicationStatus.UNDER_REVIEW;
      await this.applications.save(application);
    }
    return application;
  }

  /** Marks the application decided. Capability creation is `InstructorService`'s job (FR-009, FR-019), called by the same transaction there. */
  public async markApproved(id: string, adminId: string): Promise<InstructorApplication> {
    return this.markApprovedWithManager(this.applications, id, adminId);
  }

  /**
   * Same transition as {@link markApproved}, but runs against the given
   * repository/manager so `InstructorService.approveApplication` can
   * commit the application transition and the new capability row in one
   * transaction — never leaving one without the other on a mid-way failure.
   */
  public async markApprovedWithManager(
    manager: EntityManager | Repository<InstructorApplication>,
    id: string,
    adminId: string,
  ): Promise<InstructorApplication> {
    const repo =
      'getRepository' in manager ? manager.getRepository(InstructorApplication) : manager;
    const application = await repo.findOne({ where: { id } });
    if (
      !application ||
      ![InstructorApplicationStatus.SUBMITTED, InstructorApplicationStatus.UNDER_REVIEW].includes(
        application.status,
      )
    ) {
      throw new NotFoundException(
        biBody('No reviewable application found', 'لا يوجد طلب قابل للمراجعة'),
      );
    }
    application.status = InstructorApplicationStatus.APPROVED;
    application.reviewed_by = adminId;
    application.reviewed_at = new Date();
    return repo.save(application);
  }

  public async reject(id: string, adminId: string, reason: string): Promise<InstructorApplication> {
    const application = await this.getReviewable(id);
    application.status = InstructorApplicationStatus.REJECTED;
    application.reviewed_by = adminId;
    application.reviewed_at = new Date();
    application.decision_reason = reason;
    return this.applications.save(application);
  }

  /** FR-016 — lifts the 3-application block for one applicant. */
  public async resetAttempts(
    applicantUserId: string,
    adminId: string,
    reason: string,
  ): Promise<void> {
    await this.activityLogs.recordAuditEvent(
      new MarketplaceApplicationAttemptsResetEvent(adminId, applicantUserId, { reason }),
    );
  }

  // --------------------------------------------------------------- helpers

  private async getEditable(userId: string): Promise<InstructorApplication> {
    const application = await this.applications.findOne({
      where: [
        { user_id: userId, status: InstructorApplicationStatus.DRAFT },
        { user_id: userId, status: InstructorApplicationStatus.REJECTED },
      ],
      order: { created_at: 'DESC' },
    });
    if (!application) {
      throw new NotFoundException(
        biBody(
          'No editable application found (must be draft or rejected)',
          'لا يوجد طلب قابل للتعديل (يجب أن يكون مسودة أو مرفوضًا)',
        ),
      );
    }
    return application;
  }

  private async getReviewable(id: string): Promise<InstructorApplication> {
    const application = await this.applications.findOne({ where: { id } });
    if (
      !application ||
      ![InstructorApplicationStatus.SUBMITTED, InstructorApplicationStatus.UNDER_REVIEW].includes(
        application.status,
      )
    ) {
      throw new NotFoundException(
        biBody('No reviewable application found', 'لا يوجد طلب قابل للمراجعة'),
      );
    }
    return application;
  }

  private missingMandatoryFields(application: InstructorApplication): string[] {
    const missing: string[] = [];
    if (!application.display_name?.trim()) missing.push('display_name');
    if (!application.photo_key?.trim()) missing.push('photo_key');
    if (!application.headline?.trim()) missing.push('headline');
    if (!application.bio?.trim()) missing.push('bio');
    if (application.years_of_experience === null || application.years_of_experience === undefined) {
      missing.push('years_of_experience');
    }
    if (!application.specializations || application.specializations.length === 0)
      missing.push('specializations');
    if (!application.intended_category_ids || application.intended_category_ids.length === 0) {
      missing.push('intended_category_ids');
    }
    const hasLink = (application.professional_links?.length ?? 0) > 0;
    const hasPortfolio = (application.portfolio_items?.length ?? 0) > 0;
    if (!hasLink && !hasPortfolio) missing.push('professional_links_or_portfolio_items');
    return missing;
  }

  /** FR-016: refused within 14 days of the most recent rejection, or after 3 rejections since the last admin reset. */
  private async assertResubmissionAllowed(userId: string): Promise<void> {
    const config = getMarketplaceConfig();
    const resetWatermark = await this.activityLogs.getLatestAuditRecord(
      RESET_ATTEMPTS_ACTION,
      RESET_ATTEMPTS_TARGET_TYPE,
      userId,
    );
    const since = resetWatermark?.created_at ?? new Date(0);

    const rejections = await this.applications.find({
      where: { user_id: userId, status: InstructorApplicationStatus.REJECTED },
      order: { reviewed_at: 'DESC' },
    });
    const rejectionsSinceReset = rejections.filter((r) => (r.reviewed_at ?? r.updated_at) > since);

    if (rejectionsSinceReset.length >= config.applicationMaxAttempts) {
      throw applicationResubmissionBlocked('attempt_limit');
    }

    const mostRecent = rejectionsSinceReset[0];
    if (mostRecent?.reviewed_at) {
      const availableFrom = new Date(
        mostRecent.reviewed_at.getTime() +
          config.applicationResubmissionWaitDays * 24 * 60 * 60 * 1000,
      );
      if (new Date() < availableFrom) {
        throw applicationResubmissionBlocked('wait_period', availableFrom);
      }
    }
  }
}
