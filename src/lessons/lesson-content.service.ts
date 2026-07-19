import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { In, Repository } from 'typeorm';

import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { biBody } from '../i18n/error-translator.util';
import { NotificationType } from '../notifications/entities';
import { HomeworkAssignedEvent, PARENT_EVENT_CHANNEL } from '../notifications/events/parent-events';
import { NotificationsService } from '../notifications/services/notifications.service';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { User } from '../users/entities/user.entity';
import {
  CreateAttachmentDto,
  CreateHomeworkDto,
  GradeHomeworkDto,
  SubmitHomeworkDto,
  UpdateHomeworkDto,
} from './dto';
import { HomeworkSubmission } from './entities/homework-submission.entity';
import { Lesson } from './entities/lesson.entity';
import { LessonAttachment } from './entities/lesson-attachment.entity';
import { LessonHomework } from './entities/lesson-homework.entity';
import { LessonNote } from './entities/lesson-note.entity';

@Injectable()
export class LessonContentService {
  private readonly logger = new Logger(LessonContentService.name);

  constructor(
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(LessonAttachment)
    private readonly attachmentsRepository: Repository<LessonAttachment>,
    @InjectRepository(LessonHomework)
    private readonly homeworkRepository: Repository<LessonHomework>,
    @InjectRepository(HomeworkSubmission)
    private readonly homeworkSubmissions: Repository<HomeworkSubmission>,
    @InjectRepository(LessonNote)
    private readonly notesRepository: Repository<LessonNote>,
    @InjectRepository(LessonPurchase)
    private readonly lessonPurchases: Repository<LessonPurchase>,
    @InjectRepository(PackagePurchase)
    private readonly packagePurchases: Repository<PackagePurchase>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
  ) {}

  private async assertOwnedLesson(lessonId: string, teacherId: string): Promise<void> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });
    if (!lesson) {
      throw new NotFoundException(
        biBody(`Lesson with ID ${lessonId} not found`, `الدرس بالمعرّف ${lessonId} غير موجود`),
      );
    }
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only manage your own lessons', 'يمكنك إدارة دروسك الخاصة فقط'),
      );
    }
  }

  /* ===================== Attachments ===================== */

  public async listAttachments(lessonId: string, teacherId: string): Promise<LessonAttachment[]> {
    await this.assertOwnedLesson(lessonId, teacherId);
    return this.attachmentsRepository.find({
      where: { lesson_id: lessonId },
      order: { created_at: 'ASC' },
    });
  }

  /**
   * Raw attachments read with NO ownership check. Callers (viewer routes) must
   * authorize first via LessonsService.assertViewerAccess.
   */
  public async getAttachmentsForLesson(lessonId: string): Promise<LessonAttachment[]> {
    return this.attachmentsRepository.find({
      where: { lesson_id: lessonId },
      order: { created_at: 'ASC' },
    });
  }

  /* ===================== Personal notes ===================== */

  /** The caller's private note for a lesson, or null if none saved yet. */
  public async getNote(userId: string, lessonId: string): Promise<LessonNote | null> {
    return this.notesRepository.findOne({
      where: { user_id: userId, lesson_id: lessonId },
    });
  }

  /** Create-or-update the caller's private note for a lesson. */
  public async upsertNote(userId: string, lessonId: string, content: string): Promise<LessonNote> {
    const existing = await this.getNote(userId, lessonId);
    if (existing) {
      existing.content = content;
      return this.notesRepository.save(existing);
    }
    return this.notesRepository.save(
      this.notesRepository.create({
        user_id: userId,
        lesson_id: lessonId,
        content,
      }),
    );
  }

  public async addAttachment(
    lessonId: string,
    teacherId: string,
    dto: CreateAttachmentDto,
  ): Promise<LessonAttachment> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const attachment = this.attachmentsRepository.create({
      lesson_id: lessonId,
      name: dto.name,
      name_ar: dto.name_ar ?? null,
      url: dto.url,
      type: dto.type ?? 'other',
      size_bytes: dto.size_bytes ?? null,
    });
    return this.attachmentsRepository.save(attachment);
  }

  public async deleteAttachment(
    lessonId: string,
    attachmentId: string,
    teacherId: string,
  ): Promise<void> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const attachment = await this.attachmentsRepository.findOne({
      where: { id: attachmentId, lesson_id: lessonId },
    });
    if (!attachment) {
      throw new NotFoundException(biBody('Attachment not found', 'المرفق غير موجود'));
    }
    await this.attachmentsRepository.remove(attachment);
  }

  /* ===================== Homework ===================== */

  public async listHomework(lessonId: string, teacherId: string): Promise<LessonHomework[]> {
    await this.assertOwnedLesson(lessonId, teacherId);
    return this.homeworkRepository.find({
      where: { lesson_id: lessonId },
      order: { created_at: 'ASC' },
    });
  }

  public async addHomework(
    lessonId: string,
    teacherId: string,
    dto: CreateHomeworkDto,
  ): Promise<LessonHomework> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const homework = this.homeworkRepository.create({
      lesson_id: lessonId,
      title: dto.title,
      title_ar: dto.title_ar ?? null,
      description: dto.description ?? null,
      description_ar: dto.description_ar ?? null,
      type: dto.type ?? 'text',
      resource_url: dto.resource_url ?? null,
      due_at: dto.due_at ? new Date(dto.due_at) : null,
      questions: this.normalizeQuestions(dto.questions),
      max_score: dto.max_score ?? 100,
      published_at: null,
    });
    return this.homeworkRepository.save(homework);
  }

  public async updateHomework(
    lessonId: string,
    homeworkId: string,
    teacherId: string,
    dto: UpdateHomeworkDto,
  ): Promise<LessonHomework> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const homework = await this.homeworkRepository.findOne({
      where: { id: homeworkId, lesson_id: lessonId },
    });
    if (!homework) {
      throw new NotFoundException(biBody('Homework not found', 'الواجب غير موجود'));
    }
    if (dto.title !== undefined) homework.title = dto.title;
    if (dto.title_ar !== undefined) homework.title_ar = dto.title_ar;
    if (dto.description !== undefined) homework.description = dto.description;
    if (dto.description_ar !== undefined) homework.description_ar = dto.description_ar;
    if (dto.type !== undefined) homework.type = dto.type;
    if (dto.resource_url !== undefined) homework.resource_url = dto.resource_url;
    if (dto.due_at !== undefined) {
      homework.due_at = dto.due_at ? new Date(dto.due_at) : null;
    }
    if (dto.questions !== undefined) homework.questions = this.normalizeQuestions(dto.questions);
    if (dto.max_score !== undefined) homework.max_score = dto.max_score;

    const saved = await this.homeworkRepository.save(homework);
    if (
      saved.published_at !== null &&
      (dto.title !== undefined || dto.title_ar !== undefined || dto.due_at !== undefined)
    ) {
      await this.dispatchHomeworkNotifications(saved, 'updated');
    }
    return saved;
  }

  /** Publish a draft assignment once; publishing is the notification trigger. */
  public async publishHomework(
    lessonId: string,
    homeworkId: string,
    teacherId: string,
  ): Promise<LessonHomework> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const homework = await this.homeworkRepository.findOne({
      where: { id: homeworkId, lesson_id: lessonId },
    });
    if (!homework) {
      throw new NotFoundException(biBody('Homework not found', 'الواجب غير موجود'));
    }
    if (homework.published_at !== null) return homework;

    homework.published_at = new Date();
    const saved = await this.homeworkRepository.save(homework);
    await this.dispatchHomeworkNotifications(saved, 'assigned');
    return saved;
  }

  /** Student assignment feed, including the student's current submission. */
  public async listStudentHomework(studentId: string): Promise<Record<string, unknown>[]> {
    const qb = this.homeworkRepository
      .createQueryBuilder('homework')
      .innerJoinAndSelect('homework.lesson', 'lesson')
      .leftJoinAndSelect(
        'homework.submissions',
        'submission',
        'submission.student_id = :studentId',
        { studentId },
      )
      .where('homework.published_at IS NOT NULL')
      .andWhere('homework.deleted_at IS NULL');
    this.applyStudentHomeworkAccess(qb, studentId);
    const rows = await qb
      .orderBy('homework.due_at', 'ASC', 'NULLS LAST')
      .addOrderBy('homework.published_at', 'DESC')
      .getMany();

    return rows.map((homework) => ({
      ...homework,
      lesson: {
        id: homework.lesson.id,
        title: homework.lesson.title,
        title_ar: homework.lesson.title_ar,
      },
      submission: homework.submissions[0] ?? null,
      submissions: undefined,
    }));
  }

  public async assertStudentCanAccessHomework(
    studentId: string,
    homeworkId: string,
  ): Promise<LessonHomework> {
    const qb = this.homeworkRepository
      .createQueryBuilder('homework')
      .innerJoinAndSelect('homework.lesson', 'lesson')
      .where('homework.id = :homeworkId', { homeworkId })
      .andWhere('homework.published_at IS NOT NULL')
      .andWhere('homework.deleted_at IS NULL');
    this.applyStudentHomeworkAccess(qb, studentId);
    const homework = await qb.getOne();
    if (!homework) {
      // 404 for both missing and unauthorized ids avoids leaking paid content.
      throw new NotFoundException(biBody('Homework not found', 'الواجب غير موجود'));
    }
    return homework;
  }

  public async submitHomework(
    studentId: string,
    homeworkId: string,
    dto: SubmitHomeworkDto,
  ): Promise<HomeworkSubmission> {
    const homework = await this.assertStudentCanAccessHomework(studentId, homeworkId);
    this.validateHomeworkResponse(homework, dto);

    const existing = await this.homeworkSubmissions.findOne({
      where: { homework_id: homeworkId, student_id: studentId },
    });
    if (existing?.status === 'graded') {
      throw new BadRequestException(
        biBody('A graded homework submission cannot be replaced', 'لا يمكن استبدال واجب تم تصحيحه'),
      );
    }

    const submittedAt = new Date();
    const submission =
      existing ??
      this.homeworkSubmissions.create({
        homework_id: homeworkId,
        student_id: studentId,
      });
    submission.answer_text = dto.answer_text?.trim() || null;
    submission.answers = (dto.answers ?? []).map((answer) => ({
      question_id: answer.question_id,
      answer: answer.answer.trim(),
    }));
    submission.resource_url = dto.resource_url?.trim() || null;
    submission.status = 'submitted';
    submission.is_late = homework.due_at !== null && submittedAt > homework.due_at;
    submission.score = null;
    submission.feedback = null;
    submission.submitted_at = submittedAt;
    submission.graded_at = null;
    submission.graded_by = null;
    return this.homeworkSubmissions.save(submission);
  }

  /** Every enrolled student, including explicit `not_submitted` rows. */
  public async listHomeworkSubmissions(
    lessonId: string,
    homeworkId: string,
    teacherId: string,
  ): Promise<Record<string, unknown>[]> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const homework = await this.homeworkRepository.findOne({
      where: { id: homeworkId, lesson_id: lessonId },
    });
    if (!homework) throw new NotFoundException(biBody('Homework not found', 'الواجب غير موجود'));

    const studentIds = await this.getLessonStudentIds(lessonId);
    if (studentIds.length === 0) return [];
    const [students, submissions] = await Promise.all([
      this.users.find({ where: { id: In(studentIds) }, order: { name: 'ASC' } }),
      this.homeworkSubmissions.find({
        where: { homework_id: homeworkId, student_id: In(studentIds) },
      }),
    ]);
    const submissionByStudent = new Map(submissions.map((row) => [row.student_id, row]));
    return students.map((student) => {
      const submission = submissionByStudent.get(student.id) ?? null;
      return {
        student: { id: student.id, name: student.name, email: student.email },
        status: submission?.status ?? 'not_submitted',
        submission,
        max_score: Number(homework.max_score),
        due_at: homework.due_at,
      };
    });
  }

  public async gradeHomework(
    lessonId: string,
    homeworkId: string,
    submissionId: string,
    teacherId: string,
    dto: GradeHomeworkDto,
  ): Promise<HomeworkSubmission> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const homework = await this.homeworkRepository.findOne({
      where: { id: homeworkId, lesson_id: lessonId },
    });
    if (!homework) throw new NotFoundException(biBody('Homework not found', 'الواجب غير موجود'));
    if (dto.score > Number(homework.max_score)) {
      throw new BadRequestException(
        biBody(
          `Score cannot exceed ${String(homework.max_score)}`,
          `لا يمكن أن تتجاوز الدرجة ${String(homework.max_score)}`,
        ),
      );
    }

    const submission = await this.homeworkSubmissions.findOne({
      where: { id: submissionId, homework_id: homeworkId },
    });
    if (!submission) {
      throw new NotFoundException(
        biBody('Homework submission not found', 'إجابة الواجب غير موجودة'),
      );
    }
    submission.status = 'graded';
    submission.score = dto.score;
    submission.feedback = dto.feedback?.trim() || null;
    submission.graded_at = new Date();
    submission.graded_by = teacherId;
    const saved = await this.homeworkSubmissions.save(submission);

    await this.notifications.create(
      {
        user_id: submission.student_id,
        type: NotificationType.HOMEWORK,
        title: 'Homework graded',
        message: `Your result for “${homework.title}” is ${String(dto.score)}/${String(homework.max_score)}.`,
        data: { homework_id: homework.id, submission_id: submission.id, href: '/student/homework' },
        send_sms: false,
      },
      false,
    );
    return saved;
  }

  public async deleteHomework(
    lessonId: string,
    homeworkId: string,
    teacherId: string,
  ): Promise<void> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const homework = await this.homeworkRepository.findOne({
      where: { id: homeworkId, lesson_id: lessonId },
    });
    if (!homework) {
      throw new NotFoundException(biBody('Homework not found', 'الواجب غير موجود'));
    }
    await this.homeworkRepository.softRemove(homework);
  }

  private normalizeQuestions(
    questions: CreateHomeworkDto['questions'] | UpdateHomeworkDto['questions'],
  ): LessonHomework['questions'] {
    return (questions ?? []).map((question) => ({
      id: question.id ?? randomUUID(),
      prompt: question.prompt.trim(),
      prompt_ar: question.prompt_ar?.trim() || null,
    }));
  }

  private applyStudentHomeworkAccess(
    qb: ReturnType<Repository<LessonHomework>['createQueryBuilder']>,
    studentId: string,
  ): void {
    qb.andWhere(
      `(EXISTS (
        SELECT 1 FROM lesson_purchases lp
        WHERE lp.student_id = :studentId
          AND lp.lesson_id = homework.lesson_id
          AND lp.access_expires_at > :accessNow
      ) OR EXISTS (
        SELECT 1 FROM package_purchases pp
        INNER JOIN lesson_package_items lpi ON lpi.package_id = pp.package_id
        WHERE pp.student_id = :studentId
          AND lpi.lesson_id = homework.lesson_id
      ))`,
      { studentId, accessNow: new Date() },
    );
  }

  private validateHomeworkResponse(homework: LessonHomework, dto: SubmitHomeworkDto): void {
    const hasText = (dto.answer_text?.trim().length ?? 0) > 0;
    const hasFile = (dto.resource_url?.trim().length ?? 0) > 0;
    const answers = dto.answers ?? [];
    if (!hasText && !hasFile && answers.length === 0) {
      throw new BadRequestException(
        biBody('Add an answer or a file before submitting', 'أضف إجابة أو ملفًا قبل التسليم'),
      );
    }

    const expectedIds = new Set(homework.questions.map((question) => question.id));
    const receivedIds = new Set<string>();
    for (const answer of answers) {
      if (!expectedIds.has(answer.question_id) || receivedIds.has(answer.question_id)) {
        throw new BadRequestException(
          biBody('Invalid homework answers', 'إجابات الواجب غير صالحة'),
        );
      }
      receivedIds.add(answer.question_id);
    }
    if (expectedIds.size > 0 && [...expectedIds].some((id) => !receivedIds.has(id))) {
      throw new BadRequestException(
        biBody(
          'Answer every homework question before submitting',
          'أجب عن كل أسئلة الواجب قبل التسليم',
        ),
      );
    }
  }

  private async getLessonStudentIds(lessonId: string): Promise<string[]> {
    const [direct, viaPackages] = await Promise.all([
      this.lessonPurchases
        .createQueryBuilder('purchase')
        .where('purchase.lesson_id = :lessonId', { lessonId })
        .andWhere('purchase.access_expires_at > :now', { now: new Date() })
        .select('purchase.student_id', 'student_id')
        .distinct(true)
        .getRawMany<{ student_id: string }>(),
      this.packagePurchases
        .createQueryBuilder('purchase')
        .innerJoin('purchase.package', 'package')
        .innerJoin('package.items', 'item', 'item.lesson_id = :lessonId', { lessonId })
        .select('purchase.student_id', 'student_id')
        .distinct(true)
        .getRawMany<{ student_id: string }>(),
    ]);
    return [...new Set([...direct, ...viaPackages].map((row) => row.student_id))];
  }

  private async dispatchHomeworkNotifications(
    homework: LessonHomework,
    action: 'assigned' | 'updated',
  ): Promise<void> {
    const lesson = await this.lessonsRepository.findOne({ where: { id: homework.lesson_id } });
    if (!lesson) return;
    const studentIds = await this.getLessonStudentIds(homework.lesson_id);
    if (studentIds.length === 0) return;
    const students = await this.users.find({ where: { id: In(studentIds) } });

    const outcomes = await Promise.allSettled(
      students.map(async (student) => {
        const arabic = student.preferred_language === PreferredLanguage.AR;
        const title = arabic
          ? action === 'assigned'
            ? 'واجب جديد'
            : 'تم تحديث الواجب'
          : action === 'assigned'
            ? 'New homework'
            : 'Homework updated';
        const due = homework.due_at?.toISOString() ?? null;
        const requirements = arabic
          ? (homework.description_ar ?? homework.description)
          : homework.description;
        const message = arabic
          ? `${homework.title_ar ?? homework.title}${requirements ? ` — ${requirements}` : ''}${due ? ` — موعد التسليم ${homework.due_at?.toLocaleString('ar-EG') ?? due}` : ''}`
          : `${homework.title}${requirements ? ` — ${requirements}` : ''}${due ? ` — due ${homework.due_at?.toLocaleString('en-US') ?? due}` : ''}`;
        await this.notifications.create(
          {
            user_id: student.id,
            type: NotificationType.HOMEWORK,
            title,
            message,
            data: {
              homework_id: homework.id,
              lesson_id: lesson.id,
              due_at: due,
              href: '/student/homework',
            },
            send_sms: false,
          },
          false,
        );
        if (action === 'assigned') {
          this.events.emit(
            PARENT_EVENT_CHANNEL,
            new HomeworkAssignedEvent(student.id, homework.id, {
              studentName: student.name,
              lessonName: lesson.title,
              homeworkTitle: homework.title,
              dueAt: due,
            }),
          );
        }
      }),
    );
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(
        `Homework ${homework.id}: failed to create ${String(failed)}/${String(outcomes.length)} notification(s)`,
      );
    }
  }
}
