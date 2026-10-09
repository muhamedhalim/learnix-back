import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { SanitizationService } from '../../common/sanitization/sanitization.service';
import { getMarketplaceConfig } from '../../config/marketplace.config';
import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceEnrollment } from '../commerce/entities';
import { MarketplaceCourseStatus } from '../common/enums';
import { courseFreePreviewBoundExceeded, courseHasEnrollments, courseNotEditableWhileUnderReview } from '../common/errors';
import { slugify } from '../common/utils/slugify.util';
import type { CreateCourseDto, CreateSectionDto, UpdateCourseDto, UpdateSectionDto } from './dto/course.dto';
import type { CreateLessonDto, UpdateLessonDto } from './dto/lesson.dto';
import { loadLessonsBySection } from './curriculum.util';
import {
  MarketplaceCourse,
  MarketplaceCourseLesson,
  MarketplaceCourseReviewDecision,
  MarketplaceCourseSection,
} from './entities';

/**
 * An instructor's own course in the list view (T073). Rejected courses carry the reasons of their
 * latest review decision (`null` when there is no decision row), so the list page does not have to
 * fetch each rejected course's decisions separately. Other statuses omit the field.
 */
export type OwnCourseListItem = MarketplaceCourse & { latest_review_reasons?: string[] | null };

/**
 * FR-041 – FR-050, FR-054. Course, section and lesson authoring for the
 * owning instructor only — every read and write is scoped by `instructorId`
 * at the query level, never a post-fetch ownership check (no IDOR).
 *
 * This mutates the course's *working* row and curriculum directly. What a
 * buyer or the public sees is a separate concern (`MarketplaceCourseVersion`
 * snapshots, T063/T064) — this service has no notion of "published" beyond
 * refusing edits while `submitted_for_review` (FR-063).
 */
@Injectable()
export class CourseAuthoringService {
  constructor(
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
    @InjectRepository(MarketplaceCourseSection)
    private readonly sections: Repository<MarketplaceCourseSection>,
    @InjectRepository(MarketplaceCourseLesson)
    private readonly lessons: Repository<MarketplaceCourseLesson>,
    @InjectRepository(MarketplaceEnrollment)
    private readonly enrollments: Repository<MarketplaceEnrollment>,
    private readonly sanitization: SanitizationService,
    @InjectRepository(MarketplaceCourseReviewDecision)
    private readonly decisions: Repository<MarketplaceCourseReviewDecision>,
  ) {}

  // -------------------------------------------------------------- course

  public async listOwnCourses(instructorId: string, status?: MarketplaceCourseStatus): Promise<OwnCourseListItem[]> {
    const rows: OwnCourseListItem[] = await this.courses.find({
      where: status ? { instructor_id: instructorId, status } : { instructor_id: instructorId },
      order: { created_at: 'DESC' },
    });
    // The ids come from this instructor's own rows only, so no other tenant's decisions can be read.
    const rejectedIds = rows.filter((course) => course.status === MarketplaceCourseStatus.REJECTED).map((course) => course.id);
    if (rejectedIds.length === 0) return rows;

    // One row per rejected course: the latest decision, whatever its `decision` value (what the
    // per-course `review-decisions` endpoint's first row has always been). Merged by course id, never
    // joined into the course query.
    const latest: { course_id: string; reasons: string[] }[] = await this.decisions.query(
      `SELECT DISTINCT ON (course_id) course_id, reasons
         FROM marketplace_course_review_decisions
        WHERE course_id = ANY($1::uuid[])
        ORDER BY course_id, reviewed_at DESC`,
      [rejectedIds],
    );
    const reasonsByCourse = new Map(latest.map((row) => [row.course_id, row.reasons]));
    for (const course of rows) {
      if (course.status === MarketplaceCourseStatus.REJECTED) {
        course.latest_review_reasons = reasonsByCourse.get(course.id) ?? null;
      }
    }
    return rows;
  }

  public async getOwnCourse(instructorId: string, courseId: string): Promise<MarketplaceCourse> {
    return this.getOwnedCourseOrThrow(instructorId, courseId);
  }

  /** FR-282: every course, any state, any instructor — admin-only, not scoped by `instructorId`. */
  public async listAllCourses(status?: MarketplaceCourseStatus): Promise<MarketplaceCourse[]> {
    return this.courses.find({
      where: status ? { status } : {},
      // Waiting-time ordering — the same role `updated_at` plays for `IDX_mp_courses_review_queue`.
      order: { updated_at: 'ASC' },
    });
  }

  /** FR-065: the full curriculum, exactly as authored — admin review sees every lesson, not just previews. */
  public async getCourseWithCurriculum(courseId: string): Promise<{
    course: MarketplaceCourse;
    sections: (MarketplaceCourseSection & { lessons: MarketplaceCourseLesson[] })[];
  }> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    const sections = await this.sections.find({ where: { course_id: courseId }, order: { position: 'ASC' } });
    // One statement for every section's lessons, grouped back into section order (T071).
    const lessonsBySection = await loadLessonsBySection(this.lessons, sections);
    return {
      course,
      sections: sections.map((section, index) => ({ ...section, lessons: lessonsBySection[index]! })),
    };
  }

  /** FR-041: only an approved, non-suspended instructor may create — enforced by `ApprovedInstructorGuard`, not here. */
  public async createCourse(instructorId: string, dto: CreateCourseDto): Promise<MarketplaceCourse> {
    const course = this.courses.create({
      instructor_id: instructorId,
      category_id: dto.category_id,
      slug: slugify(dto.title, 'course'),
      title: this.sanitization.sanitizeStrict(dto.title),
      title_ar: dto.title_ar != null ? this.sanitization.sanitizeStrict(dto.title_ar) : null,
      summary: this.sanitization.sanitizeStrict(dto.summary),
      summary_ar: dto.summary_ar != null ? this.sanitization.sanitizeStrict(dto.summary_ar) : null,
      description: this.sanitization.sanitizeBasic(dto.description),
      description_ar: dto.description_ar ? this.sanitization.sanitizeBasic(dto.description_ar) : null,
      level: dto.level,
      language: dto.language,
      price_minor: dto.price_minor,
      currency: dto.currency,
      cover_image_key: dto.cover_image_key,
      promo_video_id: dto.promo_video_id ?? null,
      learning_outcomes: dto.learning_outcomes ?? [],
      prerequisites: dto.prerequisites ?? [],
      target_audience: dto.target_audience ?? [],
      certificate_enabled: dto.certificate_enabled ?? false,
      status: MarketplaceCourseStatus.DRAFT,
    });
    return this.courses.save(course);
  }

  public async updateCourse(instructorId: string, courseId: string, dto: UpdateCourseDto): Promise<MarketplaceCourse> {
    const course = await this.getOwnedCourseOrThrow(instructorId, courseId);
    this.assertEditable(course);

    if (dto.title !== undefined) course.title = this.sanitization.sanitizeStrict(dto.title);
    if (dto.title_ar !== undefined) course.title_ar = this.sanitization.sanitizeStrict(dto.title_ar);
    if (dto.summary !== undefined) course.summary = this.sanitization.sanitizeStrict(dto.summary);
    if (dto.summary_ar !== undefined) course.summary_ar = this.sanitization.sanitizeStrict(dto.summary_ar);
    if (dto.description !== undefined) course.description = this.sanitization.sanitizeBasic(dto.description);
    if (dto.description_ar !== undefined) course.description_ar = this.sanitization.sanitizeBasic(dto.description_ar);
    if (dto.category_id !== undefined) course.category_id = dto.category_id;
    if (dto.level !== undefined) course.level = dto.level;
    if (dto.language !== undefined) course.language = dto.language;
    if (dto.price_minor !== undefined) course.price_minor = dto.price_minor;
    if (dto.currency !== undefined) course.currency = dto.currency;
    if (dto.cover_image_key !== undefined) course.cover_image_key = dto.cover_image_key;
    if (dto.promo_video_id !== undefined) course.promo_video_id = dto.promo_video_id;
    if (dto.learning_outcomes !== undefined) course.learning_outcomes = dto.learning_outcomes;
    if (dto.prerequisites !== undefined) course.prerequisites = dto.prerequisites;
    if (dto.target_audience !== undefined) course.target_audience = dto.target_audience;
    if (dto.certificate_enabled !== undefined) course.certificate_enabled = dto.certificate_enabled;

    return this.courses.save(course);
  }

  /**
   * FR-054: deletable only when never enrolled. Queries the real (if
   * currently always-empty, since no purchase flow exists yet)
   * `marketplace_enrollments` table directly rather than depending on the
   * whole not-yet-built commerce module — same narrow-repository pattern
   * `PublicInstructorProfileService` already uses for its own aggregates.
   */
  public async deleteCourse(instructorId: string, courseId: string): Promise<void> {
    const course = await this.getOwnedCourseOrThrow(instructorId, courseId);
    const enrollmentCount = await this.enrollments.count({ where: { course_id: course.id } });
    if (enrollmentCount > 0) {
      throw courseHasEnrollments();
    }
    await this.courses.remove(course);
  }

  // ------------------------------------------------------------ section

  public async createSection(instructorId: string, courseId: string, dto: CreateSectionDto): Promise<MarketplaceCourseSection> {
    const course = await this.getOwnedCourseOrThrow(instructorId, courseId);
    this.assertEditable(course);

    const count = await this.sections.count({ where: { course_id: course.id } });
    const section = this.sections.create({
      course_id: course.id,
      title: this.sanitization.sanitizeStrict(dto.title),
      title_ar: dto.title_ar != null ? this.sanitization.sanitizeStrict(dto.title_ar) : null,
      position: count,
    });
    return this.sections.save(section);
  }

  public async updateSection(
    instructorId: string,
    courseId: string,
    sectionId: string,
    dto: UpdateSectionDto,
  ): Promise<MarketplaceCourseSection> {
    const course = await this.getOwnedCourseOrThrow(instructorId, courseId);
    this.assertEditable(course);
    const section = await this.getOwnedSectionOrThrow(course.id, sectionId);

    if (dto.title !== undefined) section.title = this.sanitization.sanitizeStrict(dto.title);
    if (dto.title_ar !== undefined) section.title_ar = this.sanitization.sanitizeStrict(dto.title_ar);
    return this.sections.save(section);
  }

  public async deleteSection(instructorId: string, courseId: string, sectionId: string): Promise<void> {
    const course = await this.getOwnedCourseOrThrow(instructorId, courseId);
    this.assertEditable(course);
    const section = await this.getOwnedSectionOrThrow(course.id, sectionId);

    // Delete and renumber together: a failed renumber must not leave a gap behind.
    await this.sections.manager.transaction(async (manager) => {
      await manager.remove(section);
      await this.recompactSectionPositions(manager, course.id);
    });
    await this.recomputeDerivedTotals(course.id);
  }

  public async reorderSections(instructorId: string, courseId: string, orderedIds: string[]): Promise<void> {
    const course = await this.getOwnedCourseOrThrow(instructorId, courseId);
    this.assertEditable(course);
    const existing = await this.sections.find({ where: { course_id: course.id } });
    this.assertSameIdSet(existing.map((s) => s.id), orderedIds, 'section');

    await this.sections.manager.transaction(async (manager) =>
      this.renumberPositions(manager, 'marketplace_course_sections', 'course_id', course.id, orderedIds),
    );
  }

  // ------------------------------------------------------------- lesson

  /** FR-046, FR-242, FR-049. `dto.section_id` names the section — lessons are flat under the course in contracts §3. */
  public async createLesson(
    instructorId: string,
    courseId: string,
    dto: CreateLessonDto,
  ): Promise<MarketplaceCourseLesson> {
    const course = await this.getOwnedCourseOrThrow(instructorId, courseId);
    this.assertEditable(course);
    const section = await this.getOwnedSectionOrThrow(course.id, dto.section_id);

    const isFreePreview = dto.is_free_preview ?? false;
    if (isFreePreview) {
      const totalInCourse = await this.countLessonsInCourse(course.id);
      await this.assertFreePreviewBound(course.id, totalInCourse + 1);
    }
    const isRequired = dto.is_required_for_completion ?? !isFreePreview;

    const count = await this.lessons.count({ where: { section_id: section.id } });
    const lesson = this.lessons.create({
      section_id: section.id,
      title: this.sanitization.sanitizeStrict(dto.title),
      title_ar: dto.title_ar != null ? this.sanitization.sanitizeStrict(dto.title_ar) : null,
      position: count,
      content_type: dto.content_type,
      video_id: dto.video_id ?? null,
      content_html: dto.content_html ? this.sanitization.sanitizeBasic(dto.content_html) : null,
      duration_seconds: dto.duration_seconds,
      is_free_preview: isFreePreview,
      is_required_for_completion: isRequired,
    });
    const saved = await this.lessons.save(lesson);
    await this.recomputeDerivedTotals(course.id);
    return saved;
  }

  public async updateLesson(
    instructorId: string,
    courseId: string,
    lessonId: string,
    dto: UpdateLessonDto,
  ): Promise<MarketplaceCourseLesson> {
    const course = await this.getOwnedCourseOrThrow(instructorId, courseId);
    this.assertEditable(course);
    const lesson = await this.getOwnedLessonInCourseOrThrow(course.id, lessonId);

    if (dto.is_free_preview === true && !lesson.is_free_preview) {
      const totalInCourse = await this.countLessonsInCourse(course.id);
      await this.assertFreePreviewBound(course.id, totalInCourse);
    }

    if (dto.title !== undefined) lesson.title = this.sanitization.sanitizeStrict(dto.title);
    if (dto.title_ar !== undefined) lesson.title_ar = this.sanitization.sanitizeStrict(dto.title_ar);
    if (dto.content_type !== undefined) lesson.content_type = dto.content_type;
    if (dto.video_id !== undefined) lesson.video_id = dto.video_id;
    if (dto.content_html !== undefined) lesson.content_html = this.sanitization.sanitizeBasic(dto.content_html);
    if (dto.duration_seconds !== undefined) lesson.duration_seconds = dto.duration_seconds;
    if (dto.is_free_preview !== undefined) lesson.is_free_preview = dto.is_free_preview;
    if (dto.is_required_for_completion !== undefined) lesson.is_required_for_completion = dto.is_required_for_completion;

    const saved = await this.lessons.save(lesson);
    if (dto.duration_seconds !== undefined) {
      await this.recomputeDerivedTotals(course.id);
    }
    return saved;
  }

  public async deleteLesson(instructorId: string, courseId: string, lessonId: string): Promise<void> {
    const course = await this.getOwnedCourseOrThrow(instructorId, courseId);
    this.assertEditable(course);
    const lesson = await this.getOwnedLessonInCourseOrThrow(course.id, lessonId);

    await this.lessons.manager.transaction(async (manager) => {
      await manager.remove(lesson);
      await this.recompactLessonPositions(manager, lesson.section_id);
    });
    await this.recomputeDerivedTotals(course.id);
  }

  public async reorderLessons(
    instructorId: string,
    courseId: string,
    sectionId: string,
    orderedIds: string[],
  ): Promise<void> {
    const course = await this.getOwnedCourseOrThrow(instructorId, courseId);
    this.assertEditable(course);
    const section = await this.getOwnedSectionOrThrow(course.id, sectionId);
    const existing = await this.lessons.find({ where: { section_id: section.id } });
    this.assertSameIdSet(existing.map((l) => l.id), orderedIds, 'lesson');

    await this.lessons.manager.transaction(async (manager) =>
      this.renumberPositions(manager, 'marketplace_course_lessons', 'section_id', section.id, orderedIds),
    );
  }

  // -------------------------------------------------------------- utils

  private async getOwnedCourseOrThrow(instructorId: string, courseId: string): Promise<MarketplaceCourse> {
    const course = await this.courses.findOne({ where: { id: courseId, instructor_id: instructorId } });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    return course;
  }

  private async getOwnedSectionOrThrow(courseId: string, sectionId: string): Promise<MarketplaceCourseSection> {
    const section = await this.sections.findOne({ where: { id: sectionId, course_id: courseId } });
    if (!section) {
      throw new NotFoundException(biBody('Section not found', 'القسم غير موجود'));
    }
    return section;
  }

  /** Finds a lesson by id, verifying (via its section) that it belongs to the given course — used by the flat `.../lessons/:lessonId` routes, which don't carry a section id. */
  private async getOwnedLessonInCourseOrThrow(courseId: string, lessonId: string): Promise<MarketplaceCourseLesson> {
    const lesson = await this.lessons
      .createQueryBuilder('l')
      .innerJoin(MarketplaceCourseSection, 's', 's.id = l.section_id')
      .where('l.id = :lessonId', { lessonId })
      .andWhere('s.course_id = :courseId', { courseId })
      .getOne();
    if (!lesson) {
      throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    }
    return lesson;
  }

  /** FR-063: read-only to the instructor while a review decision is pending. */
  private assertEditable(course: MarketplaceCourse): void {
    if (course.status === MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW) {
      throw courseNotEditableWhileUnderReview();
    }
  }

  /** FR-047: total duration and lesson count are always derived, never entered. */
  private async recomputeDerivedTotals(courseId: string): Promise<void> {
    const { count, totalDuration } = await this.lessons
      .createQueryBuilder('l')
      .innerJoin(MarketplaceCourseSection, 's', 's.id = l.section_id')
      .select('COUNT(l.id)', 'count')
      .addSelect('COALESCE(SUM(l.duration_seconds), 0)', 'totalDuration')
      .where('s.course_id = :courseId', { courseId })
      .getRawOne<{ count: string; totalDuration: string }>()
      .then((row) => ({ count: Number(row?.count ?? 0), totalDuration: Number(row?.totalDuration ?? 0) }));

    await this.courses.update({ id: courseId }, { lesson_count: count, total_duration_seconds: totalDuration });
  }

  private async countLessonsInCourse(courseId: string): Promise<number> {
    return this.lessons
      .createQueryBuilder('l')
      .innerJoin(MarketplaceCourseSection, 's', 's.id = l.section_id')
      .where('s.course_id = :courseId', { courseId })
      .getCount();
  }

  /**
   * FR-049: `max(1, floor(proportion × lessons))`, capped at the configured
   * maximum. `totalLessonsAfterChange` must already reflect the lesson
   * count *after* the caller's mutation — including the not-yet-created
   * lesson on a create, or the course's current total (unchanged) on an
   * update, since the lesson being flagged already exists there.
   */
  private async assertFreePreviewBound(courseId: string, totalLessonsAfterChange: number): Promise<void> {
    const config = getMarketplaceConfig();
    const currentPreviews = await this.lessons
      .createQueryBuilder('l')
      .innerJoin(MarketplaceCourseSection, 's', 's.id = l.section_id')
      .where('s.course_id = :courseId', { courseId })
      .andWhere('l.is_free_preview = true')
      .getCount();

    const bound = Math.min(
      config.freePreviewMaxCount,
      Math.max(1, Math.floor(config.freePreviewProportion * totalLessonsAfterChange)),
    );
    if (currentPreviews + 1 > bound) {
      throw courseFreePreviewBoundExceeded(bound);
    }
  }

  private async recompactSectionPositions(manager: EntityManager, courseId: string): Promise<void> {
    const remaining = await manager.find(MarketplaceCourseSection, {
      where: { course_id: courseId },
      order: { position: 'ASC' },
    });
    await this.renumberPositions(
      manager,
      'marketplace_course_sections',
      'course_id',
      courseId,
      remaining.map((section) => section.id),
    );
  }

  private async recompactLessonPositions(manager: EntityManager, sectionId: string): Promise<void> {
    const remaining = await manager.find(MarketplaceCourseLesson, {
      where: { section_id: sectionId },
      order: { position: 'ASC' },
    });
    await this.renumberPositions(
      manager,
      'marketplace_course_lessons',
      'section_id',
      sectionId,
      remaining.map((lesson) => lesson.id),
    );
  }

  /**
   * Give `orderedIds` the positions 0..n-1, in that order, in two statements and
   * without a unique-position collision (`UQ_mp_sections_course_position` /
   * `UQ_mp_lessons_section_position` are not deferrable, so row-by-row updates
   * collide on any swap or shift). Must run inside the caller's transaction.
   *
   * Phase 1 parks the rows on disjoint negative positions; phase 2 writes the final
   * ones. Both statements are scoped by the owning course/section, so an id from
   * another course changes nothing. A duplicated id counts once, at the place of its
   * last occurrence (the old row-by-row update also let the last one win).
   */
  private async renumberPositions(
    manager: EntityManager,
    table: 'marketplace_course_sections' | 'marketplace_course_lessons',
    scopeColumn: 'course_id' | 'section_id',
    scopeId: string,
    orderedIds: string[],
  ): Promise<void> {
    const lastIndex = new Map(orderedIds.map((id, index) => [id, index] as const));
    const ids = orderedIds.filter((id, index) => lastIndex.get(id) === index);
    if (ids.length === 0) return;
    await manager.query(
      `UPDATE ${table} SET position = -(position + 1) WHERE ${scopeColumn} = $1 AND id = ANY($2::uuid[])`,
      [scopeId, ids],
    );
    await manager.query(
      `UPDATE ${table} AS t SET position = (v.ord - 1)::int
         FROM unnest($2::uuid[]) WITH ORDINALITY AS v(id, ord)
        WHERE t.id = v.id AND t.${scopeColumn} = $1`,
      [scopeId, ids],
    );
  }

  private assertSameIdSet(existingIds: string[], orderedIds: string[], kind: 'section' | 'lesson'): void {
    const existingSet = new Set(existingIds);
    const orderedSet = new Set(orderedIds);
    const matches = existingSet.size === orderedSet.size && [...existingSet].every((id) => orderedSet.has(id));
    if (!matches) {
      const message =
        kind === 'section'
          ? biBody('The reorder list must contain exactly the course’s existing sections', 'يجب أن تحتوي قائمة إعادة الترتيب على أقسام الدورة الحالية بالضبط')
          : biBody('The reorder list must contain exactly the section’s existing lessons', 'يجب أن تحتوي قائمة إعادة الترتيب على دروس القسم الحالية بالضبط');
      throw new NotFoundException(message);
    }
  }
}
