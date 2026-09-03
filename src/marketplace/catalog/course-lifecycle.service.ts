import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';

import { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { biBody } from '../../i18n/error-translator.util';
import { CourseReviewDecisionValue, MarketplaceCourseStatus } from '../common/enums';
import {
  courseAlreadyDecided,
  courseIllegalTransition,
  courseNotReadyForSubmission,
  coursePermanentlyRemoved,
} from '../common/errors';
import {
  MarketplaceCourseApprovedEvent as CourseApprovedAuditEvent,
  MarketplaceCourseRejectedEvent as CourseRejectedAuditEvent,
  MarketplaceCourseUnpublishedEvent as CourseUnpublishedAuditEvent,
} from '../events/audit.events';
import {
  MarketplaceCourseApprovedEvent as CourseApprovedDomainEvent,
  MarketplaceCoursePublishedEvent as CoursePublishedDomainEvent,
  MarketplaceCourseRejectedEvent as CourseRejectedDomainEvent,
  MarketplaceCourseSubmittedEvent as CourseSubmittedDomainEvent,
  MarketplaceCourseUnpublishedEvent as CourseUnpublishedDomainEvent,
} from '../events/domain.events';
import { CourseReadinessService } from './course-readiness.service';
import { CourseVersionService } from './course-version.service';
import { MarketplaceCourse, MarketplaceCourseReviewDecision } from './entities';

/**
 * FR-059 – FR-069, FR-073, FR-290. The six-state machine — exactly the
 * transitions FR-060 permits, each its own method rather than a generic
 * `transition(to)` so an illegal call is a type-level wrong-method-name
 * mistake, not a runtime string the caller has to get right.
 *
 * Audit records (FR-290) are recorded only for administrative decisions —
 * approve, reject, an admin's unpublish — never for the instructor's own
 * submit/publish/unpublish, which are self-service and get a domain event
 * only. Same line the applications events already draw.
 */
@Injectable()
export class CourseLifecycleService {
  constructor(
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceCourseReviewDecision)
    private readonly decisions: Repository<MarketplaceCourseReviewDecision>,
    private readonly readiness: CourseReadinessService,
    private readonly versions: CourseVersionService,
    private readonly activityLogs: ActivityLogsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** `draft|rejected → submitted_for_review`. FR-056: refused with every failed checklist item when not ready. */
  public async submit(instructorId: string, courseId: string): Promise<MarketplaceCourse> {
    const course = await this.getOwnedOrThrow(instructorId, courseId);
    this.assertFrom(
      course,
      [MarketplaceCourseStatus.DRAFT, MarketplaceCourseStatus.REJECTED],
      MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW,
    );

    const result = await this.readiness.evaluate(courseId);
    if (!result.ready) {
      throw courseNotReadyForSubmission(result.items.filter((i) => !i.passed).map((i) => i.key));
    }

    course.status = MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW;
    const saved = await this.courses.save(course);
    this.eventEmitter.emit(
      CourseSubmittedDomainEvent.EVENT_NAME,
      new CourseSubmittedDomainEvent(courseId, instructorId),
    );
    return saved;
  }

  /**
   * `submitted_for_review → approved`. FR-073: a conditional UPDATE guarded
   * by the expected current status — if another reviewer already decided,
   * `affected` is 0 and this caller is told they lost the race, rather than
   * silently overwriting the first decision.
   */
  public async approve(adminId: string, courseId: string): Promise<void> {
    const course = await this.applyDecision(
      adminId,
      courseId,
      CourseReviewDecisionValue.APPROVED,
      [],
      {},
    );
    await this.activityLogs.recordAuditEvent(
      new CourseApprovedAuditEvent(adminId, courseId, { courseTitle: course.title }),
    );
    this.eventEmitter.emit(
      CourseApprovedDomainEvent.EVENT_NAME,
      new CourseApprovedDomainEvent(courseId, course.instructor_id),
    );
  }

  /** `submitted_for_review → rejected`. `reasons` and `itemNotes` are mandatory content, enforced at the DTO layer. */
  public async reject(
    adminId: string,
    courseId: string,
    reasons: string[],
    itemNotes: Record<string, unknown> = {},
  ): Promise<void> {
    const course = await this.applyDecision(
      adminId,
      courseId,
      CourseReviewDecisionValue.REJECTED,
      reasons,
      itemNotes,
    );
    await this.activityLogs.recordAuditEvent(
      new CourseRejectedAuditEvent(adminId, courseId, { courseTitle: course.title, reasons }),
    );
    this.eventEmitter.emit(
      CourseRejectedDomainEvent.EVENT_NAME,
      new CourseRejectedDomainEvent(courseId, course.instructor_id, reasons),
    );
  }

  /**
   * `approved → published`. FR-067: instructor-triggered only — never
   * automatic on approval. Also takes the course's first version snapshot
   * (FR-074) — nothing is buyer-visible until this call.
   */
  public async publish(instructorId: string, courseId: string): Promise<MarketplaceCourse> {
    const course = await this.getOwnedOrThrow(instructorId, courseId);
    this.assertFrom(course, [MarketplaceCourseStatus.APPROVED], MarketplaceCourseStatus.PUBLISHED);

    course.status = MarketplaceCourseStatus.PUBLISHED;
    const now = new Date();
    if (!course.first_published_at) course.first_published_at = now;
    course.last_published_at = now;
    const saved = await this.courses.save(course);
    const version = await this.versions.publishSnapshot(courseId, instructorId);
    this.eventEmitter.emit(
      CoursePublishedDomainEvent.EVENT_NAME,
      new CoursePublishedDomainEvent(courseId, instructorId, version.id),
    );
    return saved;
  }

  /** `published → unpublished`, the instructor's own choice. FR-069: never withdraws existing access. No reason, no audit record — self-service. */
  public async unpublish(courseId: string): Promise<MarketplaceCourse> {
    const course = await this.transitionToUnpublished(courseId);
    this.eventEmitter.emit(
      CourseUnpublishedDomainEvent.EVENT_NAME,
      new CourseUnpublishedDomainEvent(courseId, course.instructor_id),
    );
    return course;
  }

  /** `published → unpublished`, an administrator's decision. FR-068: reason mandatory, and — unlike the instructor's own unpublish — this is audited (FR-290). */
  public async adminUnpublish(
    adminId: string,
    courseId: string,
    reason: string,
  ): Promise<MarketplaceCourse> {
    const course = await this.transitionToUnpublished(courseId);
    await this.activityLogs.recordAuditEvent(
      new CourseUnpublishedAuditEvent(adminId, courseId, { courseTitle: course.title, reason }),
    );
    this.eventEmitter.emit(
      CourseUnpublishedDomainEvent.EVENT_NAME,
      new CourseUnpublishedDomainEvent(courseId, course.instructor_id),
    );
    return course;
  }

  /**
   * `unpublished → published`, when still approved — no new *review* cycle
   * (FR-071's material/cosmetic gate only applies to edits made while
   * already `published`). A fresh snapshot is still taken: edits made
   * while unpublished were never classified or captured by any snapshot,
   * so the alternative would republish stale content.
   */
  public async republish(instructorId: string, courseId: string): Promise<MarketplaceCourse> {
    const course = await this.getOwnedOrThrow(instructorId, courseId);
    if (course.removed_at) {
      throw coursePermanentlyRemoved();
    }
    this.assertFrom(
      course,
      [MarketplaceCourseStatus.UNPUBLISHED],
      MarketplaceCourseStatus.PUBLISHED,
    );
    course.status = MarketplaceCourseStatus.PUBLISHED;
    course.last_published_at = new Date();
    const saved = await this.courses.save(course);
    const version = await this.versions.publishSnapshot(courseId, instructorId);
    this.eventEmitter.emit(
      CoursePublishedDomainEvent.EVENT_NAME,
      new CoursePublishedDomainEvent(courseId, instructorId, version.id),
    );
    return saved;
  }

  /** `unpublished → draft`, reopened for a fresh edit/submit cycle. */
  public async reopenForEdit(instructorId: string, courseId: string): Promise<MarketplaceCourse> {
    const course = await this.getOwnedOrThrow(instructorId, courseId);
    if (course.removed_at) {
      throw coursePermanentlyRemoved();
    }
    this.assertFrom(course, [MarketplaceCourseStatus.UNPUBLISHED], MarketplaceCourseStatus.DRAFT);
    course.status = MarketplaceCourseStatus.DRAFT;
    return this.courses.save(course);
  }

  /**
   * FR-066: rejection "so the instructor knows what to fix" requires the
   * instructor be able to read what was decided — not just the reasons DTO
   * validation demanded on the way in. Not in contracts §3's endpoint
   * table; added during T072 alongside the curriculum read (T073) to close
   * the same kind of write-only gap. Ownership is checked first via
   * `getOwnedOrThrow`, same as every other instructor-facing method here.
   */
  public async listOwnDecisions(
    instructorId: string,
    courseId: string,
  ): Promise<MarketplaceCourseReviewDecision[]> {
    await this.getOwnedOrThrow(instructorId, courseId);
    return this.listDecisions(courseId);
  }

  /** FR-282: the admin content view's equivalent — not ownership-scoped. */
  public async listDecisions(courseId: string): Promise<MarketplaceCourseReviewDecision[]> {
    return this.decisions.find({ where: { course_id: courseId }, order: { reviewed_at: 'DESC' } });
  }

  // -------------------------------------------------------------- utils

  private async applyDecision(
    adminId: string,
    courseId: string,
    decision: CourseReviewDecisionValue,
    reasons: string[],
    itemNotes: Record<string, unknown>,
  ): Promise<MarketplaceCourse> {
    const nextStatus =
      decision === CourseReviewDecisionValue.APPROVED
        ? MarketplaceCourseStatus.APPROVED
        : MarketplaceCourseStatus.REJECTED;

    const result = await this.courses.update(
      { id: courseId, status: MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW },
      { status: nextStatus },
    );
    if (!result.affected) {
      const existing = await this.courses.findOne({ where: { id: courseId } });
      if (!existing) {
        throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
      }
      throw courseAlreadyDecided();
    }

    const record = this.decisions.create({
      course_id: courseId,
      decision,
      reasons,
      item_notes: itemNotes,
      reviewed_by: adminId,
    });
    await this.decisions.save(record);

    return this.getOrThrow(courseId);
  }

  private async transitionToUnpublished(courseId: string): Promise<MarketplaceCourse> {
    const course = await this.getOrThrow(courseId);
    this.assertFrom(
      course,
      [MarketplaceCourseStatus.PUBLISHED],
      MarketplaceCourseStatus.UNPUBLISHED,
    );
    course.status = MarketplaceCourseStatus.UNPUBLISHED;
    return this.courses.save(course);
  }

  private async getOrThrow(courseId: string): Promise<MarketplaceCourse> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    return course;
  }

  private async getOwnedOrThrow(
    instructorId: string,
    courseId: string,
  ): Promise<MarketplaceCourse> {
    const course = await this.courses.findOne({
      where: { id: courseId, instructor_id: instructorId },
    });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    return course;
  }

  private assertFrom(
    course: MarketplaceCourse,
    allowed: MarketplaceCourseStatus[],
    to: MarketplaceCourseStatus,
  ): void {
    if (!allowed.includes(course.status)) {
      throw courseIllegalTransition(course.status, to);
    }
  }
}
