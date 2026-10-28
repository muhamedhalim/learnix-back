import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';

import { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceInstructorStatus } from '../common/enums';
import {
  MarketplaceApplicationApprovedEvent,
  MarketplaceApplicationRejectedEvent,
  MarketplaceInstructorReinstatedEvent,
  MarketplaceInstructorSetupLinkResentEvent,
  MarketplaceInstructorSuspendedEvent,
} from '../events/audit.events';
import {
  MarketplaceApplicationApprovedEvent as ApplicationApprovedDomainEvent,
  MarketplaceApplicationRejectedEvent as ApplicationRejectedDomainEvent,
  MarketplaceInstructorReinstatedEvent as InstructorReinstatedDomainEvent,
  MarketplaceInstructorSuspendedEvent as InstructorSuspendedDomainEvent,
} from '../events/domain.events';
import { slugify } from '../common/utils/slugify.util';
import { InstructorApplicationService } from './instructor-application.service';
import { InstructorAccountService } from './instructor-account.service';
import { InstructorApplication } from './entities/instructor-application.entity';
import { MarketplaceInstructor } from './entities/marketplace-instructor.entity';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * What approving an application tells the administrator about the applicant's login:
 * - `sent`: a freshly provisioned account was emailed its password-setup link;
 * - `failed`: it was provisioned but the email could not be queued, so the instructor cannot sign in
 *   until an administrator resends the link;
 * - `not_needed`: the applicant already had an account and signs in as before.
 */
export type AccountSetupEmailOutcome = 'sent' | 'failed' | 'not_needed';

export type ApprovedInstructor = MarketplaceInstructor & {
  account_setup_email: AccountSetupEmailOutcome;
};

@Injectable()
export class InstructorService {
  constructor(
    @InjectRepository(MarketplaceInstructor)
    private readonly instructors: Repository<MarketplaceInstructor>,
    private readonly applicationService: InstructorApplicationService,
    private readonly accounts: InstructorAccountService,
    private readonly activityLogs: ActivityLogsService,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  public async getByUserId(userId: string): Promise<MarketplaceInstructor | null> {
    return this.instructors.findOne({ where: { user_id: userId } });
  }

  public async getBySlug(slug: string): Promise<MarketplaceInstructor | null> {
    return this.instructors.findOne({ where: { slug } });
  }

  /**
   * FR-009, FR-019: approving an application creates the capability record
   * in the same transaction as the application's own state transition.
   * `users.role` is never read or written anywhere in this method — that is
   * the whole of Q2's guarantee, not merely a side effect of not needing it.
   *
   * The audit record and domain event fire only *after* the transaction has
   * actually committed — never from inside `retryTransaction`'s callback.
   * `recordAuditEvent` writes through its own repository, independent of
   * this transaction's manager; emitting from inside the callback would let
   * a deadlock-retried attempt commit an audit row for a database write
   * that never landed, or the successful retry double it.
   */
  public async approveApplication(
    applicationId: string,
    adminId: string,
  ): Promise<ApprovedInstructor> {
    const { instructor, application, account, applicantUserId } = await retryTransaction(
      this.dataSource,
      async (manager) => {
        const application = await this.applicationService.markApprovedWithManager(
          manager,
          applicationId,
          adminId,
        );

        // A public application carries no platform identity: approval is what
        // provisions one, in this same transaction so a mid-way failure can
        // never leave an account without its capability or the reverse. An
        // applicant who already had an account keeps it untouched.
        const account =
          application.user_id === null
            ? await this.accounts.resolveOrCreateAccount(manager, application)
            : null;
        if (account !== null) {
          application.user_id = account.user.id;
          try {
            await manager.getRepository(InstructorApplication).save(application);
          } catch (error) {
            // The account found for the applicant's email already has an open application of its own.
            if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
              throw new ConflictException(
                biBody(
                  "The account with this applicant's email already has another open application. Reject this one or resolve the other first.",
                  'الحساب المرتبط ببريد مقدّم الطلب لديه طلب آخر مفتوح. ارفض هذا الطلب أو عالج الآخر أولاً.',
                ),
              );
            }
            throw error;
          }
        }

        const applicantUserId = application.user_id;
        if (applicantUserId === null) {
          throw new ConflictException(
            biBody('Could not resolve the applicant account', 'تعذّر تحديد حساب مقدّم الطلب'),
          );
        }

        // One capability record per person. An applicant who is already an instructor (or whose email
        // belongs to one) used to hit the unique index and surface as a 500.
        if (await manager.findOne(MarketplaceInstructor, { where: { user_id: applicantUserId } })) {
          throw new ConflictException(
            biBody(
              'This applicant is already an instructor. Reject this application.',
              'مقدّم الطلب مدرّب بالفعل. ارفض هذا الطلب.',
            ),
          );
        }

        const instructor = manager.create(MarketplaceInstructor, {
          user_id: applicantUserId,
          application_id: application.id,
          status: MarketplaceInstructorStatus.APPROVED,
          slug: slugify(application.display_name, 'instructor'),
          display_name: application.display_name,
          headline: application.headline,
          headline_ar: application.headline_ar,
          bio: application.bio,
          bio_ar: application.bio_ar,
          years_of_experience: application.years_of_experience,
          education: application.education,
          certifications: application.certifications,
          work_experience: application.work_experience,
          specializations: application.specializations,
          skills: application.skills,
          teaching_category_ids: application.intended_category_ids,
          portfolio_items: application.portfolio_items,
          professional_links: application.professional_links,
          photo_key: application.photo_key,
          approved_at: new Date(),
          approved_by: adminId,
        });
        const saved = await manager.save(instructor);
        return { instructor: saved, application, account, applicantUserId };
      },
    );

    await this.activityLogs.recordAuditEvent(
      new MarketplaceApplicationApprovedEvent(adminId, applicationId, {
        applicantUserId,
        applicantName: application.display_name,
      }),
    );
    this.eventEmitter.emit(
      ApplicationApprovedDomainEvent.EVENT_NAME,
      new ApplicationApprovedDomainEvent(applicationId, applicantUserId, instructor.id),
    );

    // Only a freshly provisioned account needs to choose a password. A failure to send is logged and
    // reported in the result, but never unwinds (or fails) the approval above.
    let accountSetupEmail: AccountSetupEmailOutcome = 'not_needed';
    if (account?.created === true) {
      accountSetupEmail = (await this.accounts.sendAccountSetupLink(account.user))
        ? 'sent'
        : 'failed';
    }

    return Object.assign(instructor, { account_setup_email: accountSetupEmail });
  }

  /**
   * Re-sends the password-setup link to an instructor who was provisioned from a public application and
   * has not set a password. Refused when the account already has one (it can sign in or use "Forgot
   * password"), and answered 503 when the email still cannot be queued, so the administrator knows.
   */
  public async resendSetupLink(instructorId: string, adminId: string): Promise<{ sent: true }> {
    const instructor = await this.instructors.findOne({ where: { id: instructorId } });
    if (!instructor) {
      throw new NotFoundException(biBody('Instructor not found', 'المدرّب غير موجود'));
    }
    const outcome = await this.accounts.resendSetupLink(instructor.user_id);
    if (outcome === 'has_password') {
      throw new ConflictException(
        biBody(
          'This account already has a password. The instructor can sign in or use "Forgot password".',
          'لهذا الحساب كلمة مرور بالفعل. يمكن للمدرّب تسجيل الدخول أو استخدام "نسيت كلمة المرور".',
        ),
      );
    }
    if (outcome === 'not_found') {
      throw new NotFoundException(biBody('Instructor account not found', 'حساب المدرّب غير موجود'));
    }
    if (outcome === 'failed') {
      throw new ServiceUnavailableException(
        biBody(
          'The email could not be queued. Check the email configuration and try again.',
          'تعذّر وضع البريد في قائمة الإرسال. تحقق من إعدادات البريد وحاول مرة أخرى.',
        ),
      );
    }
    await this.activityLogs.recordAuditEvent(
      new MarketplaceInstructorSetupLinkResentEvent(adminId, instructor.id, {
        instructorName: instructor.display_name,
      }),
    );
    return { sent: true };
  }

  public async rejectApplication(
    applicationId: string,
    adminId: string,
    reason: string,
  ): Promise<void> {
    const application = await this.applicationService.reject(applicationId, adminId, reason);
    await this.activityLogs.recordAuditEvent(
      new MarketplaceApplicationRejectedEvent(adminId, applicationId, {
        applicantUserId: application.user_id,
        applicantName: application.display_name,
        reason,
      }),
    );
    this.eventEmitter.emit(
      ApplicationRejectedDomainEvent.EVENT_NAME,
      new ApplicationRejectedDomainEvent(applicationId, application.user_id, reason),
    );
  }

  /**
   * FR-022, FR-023: suspension touches only this row. It never revokes an
   * enrollment, reverses an earning, or writes a ledger entry — those
   * belong to other services this method does not call, which is the
   * actual guarantee (not an assertion this method makes about itself).
   */
  public async suspend(
    instructorId: string,
    adminId: string,
    reason: string,
  ): Promise<MarketplaceInstructor> {
    const instructor = await this.getOrThrow(instructorId);
    instructor.status = MarketplaceInstructorStatus.SUSPENDED;
    instructor.suspension_reason = reason;
    instructor.suspended_at = new Date();
    instructor.suspended_by = adminId;
    const saved = await this.instructors.save(instructor);

    await this.activityLogs.recordAuditEvent(
      new MarketplaceInstructorSuspendedEvent(adminId, instructorId, {
        instructorName: instructor.display_name,
        reason,
      }),
    );
    this.eventEmitter.emit(
      InstructorSuspendedDomainEvent.EVENT_NAME,
      new InstructorSuspendedDomainEvent(instructorId, instructor.user_id, reason),
    );
    return saved;
  }

  public async reinstate(instructorId: string, adminId: string): Promise<MarketplaceInstructor> {
    const instructor = await this.getOrThrow(instructorId);
    if (instructor.status !== MarketplaceInstructorStatus.SUSPENDED) {
      throw new ForbiddenException(
        biBody('Only a suspended instructor can be reinstated', 'يمكن فقط إعادة تفعيل مدرّب موقوف'),
      );
    }
    instructor.status = MarketplaceInstructorStatus.APPROVED;
    instructor.suspension_reason = null;
    instructor.suspended_at = null;
    instructor.suspended_by = null;
    const saved = await this.instructors.save(instructor);

    await this.activityLogs.recordAuditEvent(
      new MarketplaceInstructorReinstatedEvent(adminId, instructorId, {
        instructorName: instructor.display_name,
      }),
    );
    this.eventEmitter.emit(
      InstructorReinstatedDomainEvent.EVENT_NAME,
      new InstructorReinstatedDomainEvent(instructorId, instructor.user_id),
    );
    return saved;
  }

  private async getOrThrow(instructorId: string): Promise<MarketplaceInstructor> {
    const instructor = await this.instructors.findOne({ where: { id: instructorId } });
    if (!instructor) {
      throw new NotFoundException(biBody('Instructor not found', 'المدرّب غير موجود'));
    }
    return instructor;
  }
}
