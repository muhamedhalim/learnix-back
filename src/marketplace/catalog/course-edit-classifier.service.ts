import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { biBody } from '../../i18n/error-translator.util';
import { CourseReviewDecisionValue, MarketplaceCourseStatus } from '../common/enums';
import {
  MarketplaceCoursePendingEditApprovedEvent,
  MarketplaceCoursePendingEditRejectedEvent,
} from '../events/audit.events';
import { CourseVersionService } from './course-version.service';
import { MarketplaceCourse, MarketplaceCourseReviewDecision } from './entities';
import type { UpdateCourseDto } from './dto/course.dto';

export type CourseEditClassification = 'material' | 'cosmetic';

/**
 * FR-070 — the enumerated material set. Everything else in
 * {@link UpdateCourseDto} (title, summary, description and their Arabic
 * counterparts, cover image, learning outcomes, prerequisites, target
 * audience) is "typographical corrections to descriptive text and image
 * replacement" — cosmetic by FR-070's own wording.
 */
const MATERIAL_COURSE_FIELDS: ReadonlySet<keyof UpdateCourseDto> = new Set([
  'price_minor',
  'currency',
  'category_id',
  'level',
  'language',
  'certificate_enabled',
]);

/**
 * FR-070 – FR-072. Curriculum structure (sections/lessons added, removed,
 * reordered) and lesson content are always material per FR-070 — there is
 * no cosmetic curriculum edit.
 */
@Injectable()
export class CourseEditClassifierService {
  constructor(
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceCourseReviewDecision)
    private readonly decisions: Repository<MarketplaceCourseReviewDecision>,
    private readonly versions: CourseVersionService,
    private readonly activityLogs: ActivityLogsService,
  ) {}

  public classifyCourseFieldEdit(
    changedFields: (keyof UpdateCourseDto)[],
  ): CourseEditClassification {
    return changedFields.some((field) => MATERIAL_COURSE_FIELDS.has(field))
      ? 'material'
      : 'cosmetic';
  }

  /**
   * Call after a course-field edit lands on the live row. A no-op unless
   * the course is currently `published` — edits to a draft/rejected/
   * approved/unpublished course have no separate public snapshot to
   * protect, so nothing needs classifying yet.
   */
  public async handleCourseFieldEdit(
    courseId: string,
    changedFields: (keyof UpdateCourseDto)[],
    actorId: string,
  ): Promise<void> {
    // Nothing really changed (a form saved as it was): there is nothing to classify or publish.
    if (changedFields.length === 0) return;

    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course || course.status !== MarketplaceCourseStatus.PUBLISHED) return;

    if (this.classifyCourseFieldEdit(changedFields) === 'cosmetic') {
      // A snapshot captures the whole working row. While a material edit is still awaiting an
      // administrator, snapshotting here would publish that unapproved edit along with the typo fix,
      // so the cosmetic change simply rides along with the pending review.
      if (course.pending_review_since) return;
      await this.versions.publishSnapshot(courseId, actorId);
      return;
    }
    await this.markPendingIfPublished(course);
  }

  /** FR-070: curriculum structure/content changes are always material — call after any section/lesson mutation. */
  public async handleCurriculumEdit(courseId: string): Promise<void> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course || course.status !== MarketplaceCourseStatus.PUBLISHED) return;
    await this.markPendingIfPublished(course);
  }

  /** Admin approval: a fresh snapshot goes live and the pending marker clears. */
  public async approvePendingEdit(courseId: string, adminId: string): Promise<void> {
    const course = await this.getPendingOrThrow(courseId);
    const pendingSince = course.pending_review_since as Date;
    await this.claimPending(courseId);
    try {
      await this.versions.publishSnapshot(courseId, adminId);
    } catch (error) {
      // The edit is still unreviewed: put the marker back so it stays in the queue.
      await this.courses.update({ id: courseId }, { pending_review_since: pendingSince });
      throw error;
    }
    await this.decisions.save(
      this.decisions.create({
        course_id: courseId,
        decision: CourseReviewDecisionValue.APPROVED,
        reasons: [],
        item_notes: {},
        reviewed_by: adminId,
      }),
    );
    await this.activityLogs.recordAuditEvent(
      new MarketplaceCoursePendingEditApprovedEvent(adminId, courseId, {
        courseTitle: course.title,
      }),
    );
  }

  /** Admin rejection: the pending marker clears; the live row's edit is left as-is for the instructor to revise — nothing new ever went public, so there is nothing to revert. */
  public async rejectPendingEdit(
    courseId: string,
    adminId: string,
    reasons: string[],
  ): Promise<void> {
    const course = await this.getPendingOrThrow(courseId);
    await this.claimPending(courseId);
    await this.decisions.save(
      this.decisions.create({
        course_id: courseId,
        decision: CourseReviewDecisionValue.REJECTED,
        reasons,
        item_notes: {},
        reviewed_by: adminId,
      }),
    );
    await this.activityLogs.recordAuditEvent(
      new MarketplaceCoursePendingEditRejectedEvent(adminId, courseId, {
        courseTitle: course.title,
        reasons,
      }),
    );
  }

  /**
   * Clears the marker with one conditional UPDATE, so of two administrators deciding at once only
   * the first still matches (the same check-and-set `CourseLifecycleService.applyDecision` uses).
   */
  private async claimPending(courseId: string): Promise<void> {
    const result = await this.courses.update(
      { id: courseId, pending_review_since: Not(IsNull()) },
      { pending_review_since: null },
    );
    if (!result.affected) {
      throw new ConflictException(
        biBody('This edit was already decided', 'تم البت في هذا التعديل بالفعل'),
      );
    }
  }

  private async markPendingIfPublished(course: MarketplaceCourse): Promise<void> {
    if (course.pending_review_since) return;
    await this.courses.update({ id: course.id }, { pending_review_since: new Date() });
  }

  private async getPendingOrThrow(courseId: string): Promise<MarketplaceCourse> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    if (!course.pending_review_since) {
      throw new NotFoundException(
        biBody(
          'This course has no pending edit awaiting review',
          'لا يوجد لهذه الدورة تعديل بانتظار المراجعة',
        ),
      );
    }
    return course;
  }
}
