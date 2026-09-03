import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { CourseReviewDecisionValue, MarketplaceCourseStatus } from '../common/enums';
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
  ) {}

  public classifyCourseFieldEdit(changedFields: (keyof UpdateCourseDto)[]): CourseEditClassification {
    return changedFields.some((field) => MATERIAL_COURSE_FIELDS.has(field)) ? 'material' : 'cosmetic';
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
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course || course.status !== MarketplaceCourseStatus.PUBLISHED) return;

    if (this.classifyCourseFieldEdit(changedFields) === 'cosmetic') {
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
    await this.getPendingOrThrow(courseId);
    await this.versions.publishSnapshot(courseId, adminId);
    await this.courses.update({ id: courseId }, { pending_review_since: null });
    await this.decisions.save(
      this.decisions.create({
        course_id: courseId,
        decision: CourseReviewDecisionValue.APPROVED,
        reasons: [],
        item_notes: {},
        reviewed_by: adminId,
      }),
    );
  }

  /** Admin rejection: the pending marker clears; the live row's edit is left as-is for the instructor to revise — nothing new ever went public, so there is nothing to revert. */
  public async rejectPendingEdit(courseId: string, adminId: string, reasons: string[]): Promise<void> {
    await this.getPendingOrThrow(courseId);
    await this.courses.update({ id: courseId }, { pending_review_since: null });
    await this.decisions.save(
      this.decisions.create({
        course_id: courseId,
        decision: CourseReviewDecisionValue.REJECTED,
        reasons,
        item_notes: {},
        reviewed_by: adminId,
      }),
    );
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
      throw new NotFoundException(biBody('This course has no pending edit awaiting review', 'لا يوجد لهذه الدورة تعديل بانتظار المراجعة'));
    }
    return course;
  }
}
