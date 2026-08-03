import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import { PaginatedResponse, PaginationMeta } from '../../common/interfaces/pagination.interface';
import { PreferredLanguage } from '../../guardians/entities/preferred-language.enum';
import { biBody } from '../../i18n/error-translator.util';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { NotificationType } from '../../notifications/entities';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { LessonPackage } from '../../packages/entities/lesson-package.entity';
import { LessonPurchase } from '../../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../../payments/entities/package-purchase.entity';
import { Subject } from '../../subjects/entities/subject.entity';
import { User } from '../../users/entities/user.entity';
import {
  AttachQuestionDto,
  CreateExamDto,
  ExamFilterDto,
  ReorderExamItemsDto,
  RescheduleExamDto,
  UpdateExamDto,
  UpsertSectionDto,
} from '../dto';
import {
  DEFAULT_EXAM_CONFIG,
  Exam,
  ExamConfig,
  ExamQuestion,
  ExamSection,
  ExamStatus,
  Question,
} from '../entities';

/**
 * Exam Authoring service: exam shell, sections, attaching bank questions (with
 * version snapshots), and the publish lifecycle. Structure edits are only
 * permitted while the exam is a DRAFT so published exams and their attempts stay
 * immutable and consistent.
 */
@Injectable()
export class ExamAuthoringService {
  private readonly logger = new Logger(ExamAuthoringService.name);

  constructor(
    @InjectRepository(Exam) private readonly exams: Repository<Exam>,
    @InjectRepository(ExamSection) private readonly sections: Repository<ExamSection>,
    @InjectRepository(ExamQuestion) private readonly examQuestions: Repository<ExamQuestion>,
    @InjectRepository(Question) private readonly questions: Repository<Question>,
    @InjectRepository(Subject) private readonly subjects: Repository<Subject>,
    @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
    @InjectRepository(LessonPackage) private readonly packages: Repository<LessonPackage>,
    @InjectRepository(LessonPurchase)
    private readonly lessonPurchases: Repository<LessonPurchase>,
    @InjectRepository(PackagePurchase)
    private readonly packagePurchases: Repository<PackagePurchase>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly notifications: NotificationsService,
    private readonly dataSource: DataSource,
  ) {}

  public async createExam(teacherId: string, dto: CreateExamDto): Promise<Exam> {
    await this.assertSubject(dto.subject_id);
    this.assertAudience(dto.is_public ?? false, dto.lesson_id ?? null, dto.package_id ?? null);
    if (dto.lesson_id !== undefined) {
      await this.assertLesson(dto.lesson_id, teacherId, dto.subject_id);
    }
    if (dto.package_id !== undefined) await this.assertPackage(dto.package_id, teacherId);

    const exam = this.exams.create({
      teacher_id: teacherId,
      subject_id: dto.subject_id,
      lesson_id: dto.lesson_id ?? null,
      package_id: dto.package_id ?? null,
      title: dto.title,
      title_ar: dto.title_ar,
      description: dto.description ?? null,
      description_ar: dto.description_ar ?? null,
      status: ExamStatus.DRAFT,
      is_public: dto.is_public ?? false,
      config: this.mergeConfig(DEFAULT_EXAM_CONFIG, dto.config),
      total_marks: 0,
      passing_marks: dto.passing_marks,
    });
    return this.exams.save(exam);
  }

  public async updateExam(examId: string, teacherId: string, dto: UpdateExamDto): Promise<Exam> {
    const exam = await this.findOwned(examId, teacherId);
    this.assertDraft(exam);
    if (dto.subject_id !== undefined) await this.assertSubject(dto.subject_id);
    const nextSubjectId = dto.subject_id ?? exam.subject_id;
    const nextLessonId = dto.lesson_id !== undefined ? dto.lesson_id : exam.lesson_id;
    const nextPackageId = dto.package_id !== undefined ? dto.package_id : exam.package_id;
    const nextIsPublic = dto.is_public ?? exam.is_public;
    this.assertAudience(nextIsPublic, nextLessonId, nextPackageId);
    if (nextLessonId !== null) {
      await this.assertLesson(nextLessonId, teacherId, nextSubjectId);
    }
    if (nextPackageId !== null) await this.assertPackage(nextPackageId, teacherId);

    Object.assign(exam, {
      title: dto.title ?? exam.title,
      title_ar: dto.title_ar ?? exam.title_ar,
      description: dto.description ?? exam.description,
      description_ar: dto.description_ar ?? exam.description_ar,
      subject_id: dto.subject_id ?? exam.subject_id,
      lesson_id: nextLessonId,
      package_id: nextPackageId,
      is_public: nextIsPublic,
      passing_marks: dto.passing_marks ?? exam.passing_marks,
      config: dto.config ? this.mergeConfig(exam.config, dto.config) : exam.config,
    });
    return this.exams.save(exam);
  }

  /** Full authoring view: exam + ordered sections + ordered questions. */
  public async getExamForTeacher(examId: string, teacherId: string): Promise<Exam> {
    const exam = await this.exams.findOne({
      where: { id: examId, deleted_at: IsNull() },
      relations: ['sections', 'exam_questions', 'subject'],
    });
    if (!exam) throw new NotFoundException(biBody('Exam not found', 'الاختبار غير موجود'));
    if (exam.teacher_id !== teacherId)
      throw new ForbiddenException(biBody('Not your exam', 'هذا الاختبار ليس ملكك'));
    exam.sections.sort((a, b) => a.order_index - b.order_index);
    exam.exam_questions.sort((a, b) => a.order_index - b.order_index);
    return exam;
  }

  public async listExams(
    teacherId: string,
    filter: ExamFilterDto,
  ): Promise<PaginatedResponse<Exam>> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const qb = this.exams
      .createQueryBuilder('exam')
      .leftJoinAndSelect('exam.subject', 'subject')
      .where('exam.teacher_id = :teacherId', { teacherId })
      .andWhere('exam.deleted_at IS NULL');

    if (filter.subject_id) qb.andWhere('exam.subject_id = :s', { s: filter.subject_id });
    if (filter.status) qb.andWhere('exam.status = :st', { st: filter.status });
    if (filter.search !== undefined && filter.search !== '') {
      qb.andWhere('(exam.title ILIKE :q OR exam.title_ar ILIKE :q)', { q: `%${filter.search}%` });
    }
    qb.orderBy(`exam.${filter.sort_by ?? 'created_at'}`, filter.sort_order ?? 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, meta: this.meta(total, page, limit) };
  }

  // ---- sections ----

  public async addSection(
    examId: string,
    teacherId: string,
    dto: UpsertSectionDto,
  ): Promise<ExamSection> {
    const exam = await this.findOwned(examId, teacherId);
    this.assertDraft(exam);
    const count = await this.sections.count({ where: { exam_id: examId } });
    return this.sections.save(
      this.sections.create({
        exam_id: examId,
        order_index: dto.order_index ?? count,
        title: dto.title ?? null,
        title_ar: dto.title_ar ?? null,
        description: dto.description ?? null,
        shuffle_questions: dto.shuffle_questions ?? false,
      }),
    );
  }

  public async removeSection(examId: string, sectionId: string, teacherId: string): Promise<void> {
    const exam = await this.findOwned(examId, teacherId);
    this.assertDraft(exam);
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(ExamSection, { id: sectionId, exam_id: examId });
      await this.recomputeTotalMarks(manager, examId);
    });
  }

  // ---- questions ----

  public async attachQuestion(
    examId: string,
    teacherId: string,
    dto: AttachQuestionDto,
  ): Promise<ExamQuestion> {
    const exam = await this.findOwned(examId, teacherId);
    this.assertDraft(exam);

    const section = await this.sections.findOne({ where: { id: dto.section_id, exam_id: examId } });
    if (!section) {
      throw new BadRequestException(
        biBody('Section does not belong to this exam', 'هذا القسم لا ينتمي إلى هذا الاختبار'),
      );
    }

    const question = await this.questions.findOne({
      where: { id: dto.question_id, deleted_at: IsNull() },
    });
    if (!question) throw new NotFoundException(biBody('Question not found', 'السؤال غير موجود'));
    if (question.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only add your own questions', 'يمكنك فقط إضافة أسئلتك الخاصة'),
      );
    }
    if (question.is_public) {
      throw new BadRequestException(
        biBody(
          'Public practice questions cannot be attached to an exam',
          'لا يمكن إضافة أسئلة التدريب العامة إلى اختبار',
        ),
      );
    }

    const duplicate = await this.examQuestions.findOne({
      where: { exam_id: examId, question_id: dto.question_id },
    });
    if (duplicate) {
      throw new BadRequestException(
        biBody('Question is already in this exam', 'هذا السؤال موجود بالفعل في هذا الاختبار'),
      );
    }

    const count = await this.examQuestions.count({ where: { exam_id: examId } });

    return this.dataSource.transaction(async (manager) => {
      const examQuestion = manager.create(ExamQuestion, {
        exam_id: examId,
        section_id: dto.section_id,
        question_id: question.id,
        question_version: question.current_version,
        // Snapshot the pinned version → grading never depends on the mutable bank.
        type_snapshot: question.type,
        content_snapshot: question.content,
        answer_key_snapshot: question.answer_key,
        order_index: dto.order_index ?? count,
        marks: dto.marks ?? question.default_marks,
        weight: dto.weight ?? 1,
        is_bonus: dto.is_bonus ?? false,
        required: dto.required ?? true,
      });
      const saved = await manager.save(ExamQuestion, examQuestion);
      await this.recomputeTotalMarks(manager, examId);
      return saved;
    });
  }

  public async detachQuestion(
    examId: string,
    examQuestionId: string,
    teacherId: string,
  ): Promise<void> {
    const exam = await this.findOwned(examId, teacherId);
    this.assertDraft(exam);
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(ExamQuestion, { id: examQuestionId, exam_id: examId });
      await this.recomputeTotalMarks(manager, examId);
    });
  }

  public async reorderSections(
    examId: string,
    teacherId: string,
    dto: ReorderExamItemsDto,
  ): Promise<void> {
    const exam = await this.findOwned(examId, teacherId);
    this.assertDraft(exam);
    const sections = await this.sections.find({ where: { exam_id: examId } });
    this.assertExactOrder(
      sections.map((section) => section.id),
      dto.ids,
      'sections',
    );
    await this.dataSource.transaction(async (manager) => {
      await Promise.all(
        dto.ids.map((id, index) =>
          manager.update(ExamSection, { id, exam_id: examId }, { order_index: index }),
        ),
      );
    });
  }

  public async reorderQuestions(
    examId: string,
    teacherId: string,
    dto: ReorderExamItemsDto,
  ): Promise<void> {
    const exam = await this.findOwned(examId, teacherId);
    this.assertDraft(exam);
    const questions = await this.examQuestions.find({ where: { exam_id: examId } });
    this.assertExactOrder(
      questions.map((question) => question.id),
      dto.ids,
      'questions',
    );
    await this.dataSource.transaction(async (manager) => {
      await Promise.all(
        dto.ids.map((id, index) =>
          manager.update(ExamQuestion, { id, exam_id: examId }, { order_index: index }),
        ),
      );
    });
  }

  // ---- lifecycle ----

  public async publish(examId: string, teacherId: string): Promise<Exam> {
    const exam = await this.findOwned(examId, teacherId);
    if (exam.status !== ExamStatus.DRAFT) {
      throw new BadRequestException(
        biBody(
          `Only a draft exam can be published (current: ${exam.status})`,
          `يمكن نشر الاختبارات في حالة المسودة فقط (الحالة الحالية: ${exam.status})`,
        ),
      );
    }
    const questionCount = await this.examQuestions.count({ where: { exam_id: examId } });
    if (questionCount === 0) {
      throw new BadRequestException(
        biBody('Cannot publish an exam with no questions', 'لا يمكن نشر اختبار لا يحتوي على أسئلة'),
      );
    }
    if (exam.passing_marks > exam.total_marks) {
      throw new BadRequestException(
        biBody(
          `Passing marks (${String(exam.passing_marks)}) exceed total marks (${String(exam.total_marks)})`,
          `درجة النجاح (${String(exam.passing_marks)}) تتجاوز الدرجة الكلية (${String(exam.total_marks)})`,
        ),
      );
    }
    const start = exam.config.start_window_at;
    const scheduled =
      start !== null && start !== undefined && new Date(start).getTime() > Date.now();
    exam.status = scheduled ? ExamStatus.SCHEDULED : ExamStatus.PUBLISHED;
    const saved = await this.exams.save(exam);
    await this.notifyExamAudience(saved, 'assigned');
    return saved;
  }

  /** Change only the availability window of an already-published exam. */
  public async reschedule(
    examId: string,
    teacherId: string,
    dto: RescheduleExamDto,
  ): Promise<Exam> {
    const exam = await this.findOwned(examId, teacherId);
    if (exam.status !== ExamStatus.PUBLISHED && exam.status !== ExamStatus.SCHEDULED) {
      throw new BadRequestException(
        biBody(
          'Only a published or scheduled exam can be rescheduled',
          'يمكن تعديل موعد امتحان منشور أو مجدول فقط',
        ),
      );
    }
    const start =
      dto.start_window_at !== undefined
        ? dto.start_window_at
        : (exam.config.start_window_at ?? null);
    const end =
      dto.end_window_at !== undefined ? dto.end_window_at : (exam.config.end_window_at ?? null);
    if (start !== null && end !== null && new Date(start) >= new Date(end)) {
      throw new BadRequestException(
        biBody(
          'Exam closing time must be after its opening time',
          'يجب أن يكون موعد إغلاق الامتحان بعد موعد فتحه',
        ),
      );
    }
    exam.config = { ...exam.config, start_window_at: start, end_window_at: end };
    exam.status =
      start !== null && new Date(start).getTime() > Date.now()
        ? ExamStatus.SCHEDULED
        : ExamStatus.PUBLISHED;
    const saved = await this.exams.save(exam);
    await this.notifyExamAudience(saved, 'updated');
    return saved;
  }

  public async archive(examId: string, teacherId: string): Promise<Exam> {
    const exam = await this.findOwned(examId, teacherId);
    exam.status = ExamStatus.ARCHIVED;
    return this.exams.save(exam);
  }

  public async unarchive(examId: string, teacherId: string): Promise<Exam> {
    const exam = await this.findOwned(examId, teacherId);
    if (exam.status !== ExamStatus.ARCHIVED) {
      throw new BadRequestException(
        biBody(
          `Only an archived exam can be unarchived (current: ${exam.status})`,
          `يمكن إلغاء أرشفة الاختبارات المؤرشفة فقط (الحالة الحالية: ${exam.status})`,
        ),
      );
    }
    exam.status = ExamStatus.PUBLISHED;
    return this.exams.save(exam);
  }

  /** Admin-scoped archive: no teacher-ownership check. */
  public async archiveAsAdmin(examId: string): Promise<Exam> {
    const exam = await this.findAny(examId);
    exam.status = ExamStatus.ARCHIVED;
    return this.exams.save(exam);
  }

  /** Admin-scoped unarchive: no teacher-ownership check. */
  public async unarchiveAsAdmin(examId: string): Promise<Exam> {
    const exam = await this.findAny(examId);
    if (exam.status !== ExamStatus.ARCHIVED) {
      throw new BadRequestException(
        biBody(
          `Only an archived exam can be unarchived (current: ${exam.status})`,
          `يمكن إلغاء أرشفة الاختبارات المؤرشفة فقط (الحالة الحالية: ${exam.status})`,
        ),
      );
    }
    exam.status = ExamStatus.PUBLISHED;
    return this.exams.save(exam);
  }

  public async remove(examId: string, teacherId: string): Promise<void> {
    await this.findOwned(examId, teacherId);
    await this.exams.softDelete(examId);
  }

  // ---- helpers ----

  private async recomputeTotalMarks(manager: EntityManager, examId: string): Promise<void> {
    const row = await manager
      .createQueryBuilder(ExamQuestion, 'eq')
      .select('COALESCE(SUM(eq.marks), 0)', 'sum')
      .where('eq.exam_id = :examId AND eq.is_bonus = false', { examId })
      .getRawOne<{ sum: string }>();
    const total = Number.parseInt(row?.sum ?? '0', 10);
    await manager.update(Exam, { id: examId }, { total_marks: total });
  }

  private async findOwned(examId: string, teacherId: string): Promise<Exam> {
    const exam = await this.exams.findOne({ where: { id: examId, deleted_at: IsNull() } });
    if (!exam) throw new NotFoundException(biBody('Exam not found', 'الاختبار غير موجود'));
    if (exam.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only manage your own exams', 'يمكنك فقط إدارة اختباراتك الخاصة'),
      );
    }
    return exam;
  }

  private async findAny(examId: string): Promise<Exam> {
    const exam = await this.exams.findOne({ where: { id: examId, deleted_at: IsNull() } });
    if (!exam) throw new NotFoundException(biBody('Exam not found', 'الاختبار غير موجود'));
    return exam;
  }

  private assertDraft(exam: Exam): void {
    if (exam.status !== ExamStatus.DRAFT) {
      throw new BadRequestException(
        biBody(
          'Exam structure can only be edited while it is a draft',
          'لا يمكن تعديل بنية الاختبار إلا أثناء وجوده في حالة المسودة',
        ),
      );
    }
  }

  private assertExactOrder(existingIds: string[], requestedIds: string[], label: string): void {
    if (
      existingIds.length !== requestedIds.length ||
      requestedIds.some((id) => !existingIds.includes(id))
    ) {
      throw new BadRequestException(
        biBody(
          `The ${label} order must contain every item in this exam exactly once`,
          `يجب أن يتضمن ترتيب ${label} كل عنصر في الاختبار مرة واحدة`,
        ),
      );
    }
  }

  private mergeConfig(base: ExamConfig, patch?: Partial<ExamConfig>): ExamConfig {
    const merged = { ...base, ...(patch ?? {}) };
    if (
      merged.start_window_at &&
      merged.end_window_at &&
      new Date(merged.start_window_at).getTime() >= new Date(merged.end_window_at).getTime()
    ) {
      throw new BadRequestException(
        biBody(
          'The exam closing time must be after its opening time',
          'يجب أن يكون موعد إغلاق الاختبار بعد موعد فتحه',
        ),
      );
    }
    return merged;
  }

  private async assertSubject(subjectId: string): Promise<void> {
    const exists = await this.subjects.findOne({ where: { id: subjectId, deleted_at: IsNull() } });
    if (!exists) {
      throw new NotFoundException(
        biBody(`Subject ${subjectId} not found`, `المادة ${subjectId} غير موجودة`),
      );
    }
  }

  private async assertLesson(
    lessonId: string,
    teacherId: string,
    subjectId: string,
  ): Promise<void> {
    const lesson = await this.lessons.findOne({ where: { id: lessonId, deleted_at: IsNull() } });
    if (!lesson) {
      throw new NotFoundException(
        biBody(`Lesson ${lessonId} not found`, `الدرس ${lessonId} غير موجود`),
      );
    }
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only target one of your own lessons', 'يمكنك فقط استهداف درس من دروسك'),
      );
    }
    if (lesson.subject_id !== subjectId) {
      throw new BadRequestException(
        biBody(
          'The target lesson does not belong to the selected subject',
          'الدرس المستهدف لا ينتمي إلى المادة المحددة',
        ),
      );
    }
  }

  private async assertPackage(packageId: string, teacherId: string): Promise<void> {
    const course = await this.packages.findOne({ where: { id: packageId, deleted_at: IsNull() } });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    if (course.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only target one of your own courses', 'يمكنك استهداف دورة من دوراتك فقط'),
      );
    }
  }

  private assertAudience(
    isPublic: boolean,
    lessonId: string | null,
    packageId: string | null,
  ): void {
    if (isPublic && (lessonId !== null || packageId !== null)) {
      throw new BadRequestException(
        biBody(
          'A public exam cannot have a private audience',
          'لا يمكن ربط الاختبار العام بجمهور خاص',
        ),
      );
    }
    if (!isPublic && lessonId === null && packageId === null) {
      throw new BadRequestException(
        biBody(
          'A private exam must target a course or lesson',
          'يجب ربط الاختبار الخاص بدورة أو درس',
        ),
      );
    }
    if (lessonId !== null && packageId !== null) {
      throw new BadRequestException(
        biBody('Choose either a course or a lesson audience', 'اختر دورة أو درسًا كجمهور للاختبار'),
      );
    }
  }

  private async getExamAudienceIds(exam: Exam): Promise<string[]> {
    if (exam.is_public) return [];
    if (exam.package_id !== null) {
      const rows = await this.packagePurchases
        .createQueryBuilder('purchase')
        .where('purchase.package_id = :packageId', { packageId: exam.package_id })
        .select('purchase.student_id', 'student_id')
        .distinct(true)
        .getRawMany<{ student_id: string }>();
      return rows.map((row) => row.student_id);
    }
    if (exam.lesson_id === null) return [];
    const [direct, packaged] = await Promise.all([
      this.lessonPurchases
        .createQueryBuilder('purchase')
        .where('purchase.lesson_id = :lessonId', { lessonId: exam.lesson_id })
        .andWhere('purchase.access_expires_at > :now', { now: new Date() })
        .select('purchase.student_id', 'student_id')
        .distinct(true)
        .getRawMany<{ student_id: string }>(),
      this.packagePurchases
        .createQueryBuilder('purchase')
        .innerJoin('purchase.package', 'package')
        .innerJoin('package.items', 'item', 'item.lesson_id = :lessonId', {
          lessonId: exam.lesson_id,
        })
        .select('purchase.student_id', 'student_id')
        .distinct(true)
        .getRawMany<{ student_id: string }>(),
    ]);
    return [...new Set([...direct, ...packaged].map((row) => row.student_id))];
  }

  private async notifyExamAudience(exam: Exam, action: 'assigned' | 'updated'): Promise<void> {
    const studentIds = await this.getExamAudienceIds(exam);
    if (studentIds.length === 0) return;
    const students = await this.users.find({ where: { id: In(studentIds) } });
    const start = exam.config.start_window_at ?? null;
    const end = exam.config.end_window_at ?? null;
    const outcomes = await Promise.allSettled(
      students.map(async (student) => {
        const arabic = student.preferred_language === PreferredLanguage.AR;
        const title = arabic
          ? action === 'assigned'
            ? 'امتحان جديد'
            : 'تم تحديث موعد الامتحان'
          : action === 'assigned'
            ? 'New exam'
            : 'Exam schedule updated';
        const localizedName = arabic ? exam.title_ar : exam.title;
        const schedule = start
          ? arabic
            ? ` — يبدأ ${new Date(start).toLocaleString('ar-EG')}`
            : ` — opens ${new Date(start).toLocaleString('en-US')}`
          : '';
        const closes = end
          ? arabic
            ? ` — ينتهي ${new Date(end).toLocaleString('ar-EG')}`
            : ` — closes ${new Date(end).toLocaleString('en-US')}`
          : '';
        await this.notifications.create(
          {
            user_id: student.id,
            type: NotificationType.EXAM_ASSIGNED,
            title,
            message: `${localizedName}${schedule}${closes}`,
            data: {
              exam_id: exam.id,
              start_window_at: start,
              end_window_at: end,
              href: `/student/exams/${exam.id}`,
            },
            send_sms: false,
          },
          false,
        );
      }),
    );
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(
        `Exam ${exam.id}: failed to create ${String(failed)}/${String(outcomes.length)} notification(s)`,
      );
    }
  }

  private meta(total: number, page: number, limit: number): PaginationMeta {
    const totalPages = Math.ceil(total / limit);
    return {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }
}
