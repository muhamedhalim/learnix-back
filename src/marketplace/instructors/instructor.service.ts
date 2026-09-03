import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
import { MarketplaceInstructor } from './entities/marketplace-instructor.entity';

@Injectable()
export class InstructorService {
  constructor(
    @InjectRepository(MarketplaceInstructor)
    private readonly instructors: Repository<MarketplaceInstructor>,
    private readonly applicationService: InstructorApplicationService,
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
  public async approveApplication(applicationId: string, adminId: string): Promise<MarketplaceInstructor> {
    const { instructor, application } = await retryTransaction(this.dataSource, async (manager) => {
      const application = await this.applicationService.markApprovedWithManager(manager, applicationId, adminId);

      const instructor = manager.create(MarketplaceInstructor, {
        user_id: application.user_id,
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
      return { instructor: saved, application };
    });

    await this.activityLogs.recordAuditEvent(
      new MarketplaceApplicationApprovedEvent(adminId, applicationId, {
        applicantUserId: application.user_id,
        applicantName: application.display_name,
      }),
    );
    this.eventEmitter.emit(
      ApplicationApprovedDomainEvent.EVENT_NAME,
      new ApplicationApprovedDomainEvent(applicationId, application.user_id, instructor.id),
    );

    return instructor;
  }

  public async rejectApplication(applicationId: string, adminId: string, reason: string): Promise<void> {
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
  public async suspend(instructorId: string, adminId: string, reason: string): Promise<MarketplaceInstructor> {
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
      new MarketplaceInstructorReinstatedEvent(adminId, instructorId, { instructorName: instructor.display_name }),
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
