import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import { In, Repository } from 'typeorm';

import { PaginationMeta } from '../common/interfaces/pagination.interface';
import { buildAbsoluteUrl, getConfiguredPublicOrigin } from '../config/public-url.util';
import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { biBody } from '../i18n/error-translator.util';
import { NotificationType } from '../notifications/entities';
import { HomeworkAssignedEvent, PARENT_EVENT_CHANNEL } from '../notifications/events/parent-events';
import { NotificationsService } from '../notifications/services/notifications.service';
import { LessonPurchase } from '../payments/entities/lesson-purchase.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { StoredObject, StorageObjectNotFoundError } from '../storage/storage.interface';
import { StorageService } from '../storage/storage.service';
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

export interface LessonAttachmentResponse {
  id: string;
  lesson_id: string;
  name: string;
  name_ar: string | null;
  url: string;
  type: string;
  size_bytes: number | null;
  created_at: Date;
}

@Injectable()
export class LessonContentService {
  private readonly logger = new Logger(LessonContentService.name);
  private readonly apiOrigin: string;

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
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.apiOrigin = getConfiguredPublicOrigin(
      (key) => config.get<string>(key),
      'BACKEND_URL',
      'http://localhost:3001',
    );
  }

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

  public async listAttachments(
    lessonId: string,
    teacherId: string,
  ): Promise<LessonAttachmentResponse[]> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const attachments = await this.attachmentsRepository.find({
      where: { lesson_id: lessonId },
      order: { created_at: 'ASC', id: 'ASC' },
      take: 500,
    });
    return attachments.map((attachment) => this.toAttachmentResponse(attachment));
  }

  /**
   * Raw attachments read with NO ownership check. Callers (viewer routes) must
   * authorize first via LessonsService.assertViewerAccess.
   */
  public async getAttachmentsForLesson(lessonId: string): Promise<LessonAttachmentResponse[]> {
    const attachments = await this.attachmentsRepository.find({
      where: { lesson_id: lessonId },
      order: { created_at: 'ASC', id: 'ASC' },
      take: 500,
    });
    return attachments.map((attachment) => this.toAttachmentResponse(attachment));
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
  ): Promise<LessonAttachmentResponse> {
    await this.assertOwnedLesson(lessonId, teacherId);
    if (
      dto.url.includes('..') ||
      dto.url.includes('\\') ||
      /^https?:\/\//iu.test(dto.url) ||
      !dto.url.startsWith(`lesson-resources/${teacherId}/`)
    ) {
      throw new BadRequestException(
        biBody('Invalid private upload reference', 'Ù…Ø±Ø¬Ø¹ Ø§Ù„Ù…Ù„Ù Ø§Ù„Ø®Ø§Øµ ØºÙŠØ± ØµØ§Ù„Ø­'),
      );
    }
    const attachment = this.attachmentsRepository.create({
      lesson_id: lessonId,
      name: dto.name,
      name_ar: dto.name_ar ?? null,
      url: dto.url,
      type: dto.type ?? 'other',
      size_bytes: dto.size_bytes ?? null,
    });
    return this.toAttachmentResponse(await this.attachmentsRepository.save(attachment));
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
    await this.storage.tryDelete(this.storage.toKey(attachment.url));
    await this.attachmentsRepository.remove(attachment);
  }

  public async getAttachmentObject(
    lessonId: string,
    attachmentId: string,
  ): Promise<{ attachment: LessonAttachment; object: StoredObject }> {
    const attachment = await this.attachmentsRepository.findOne({
      where: { id: attachmentId, lesson_id: lessonId },
    });
    if (!attachment) {
      throw new NotFoundException(biBody('Attachment not found', 'Ù…Ø±ÙÙ‚ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'));
    }
    try {
      return {
        attachment,
        object: await this.storage.getObject(this.storage.toKey(attachment.url)),
      };
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        throw new NotFoundException(biBody('Attachment not found', 'Ù…Ø±ÙÙ‚ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'));
      }
      throw error;
    }
  }

  private toAttachmentResponse(attachment: LessonAttachment): LessonAttachmentResponse {
    return {
      id: attachment.id,
      lesson_id: attachment.lesson_id,
      name: attachment.name,
      name_ar: attachment.name_ar,
      url: buildAbsoluteUrl(
        this.apiOrigin,
        `/api/v1/lessons/${attachment.lesson_id}/attachments/${attachment.id}/download`,
      ),
      type: attachment.type,
      size_bytes: attachment.size_bytes,
      created_at: attachment.created_at,
    };
  }

  /* ===================== Homework ===================== */

  public async listHomework(lessonId: string, teacherId: string): Promise<LessonHomework[]> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const homework = await this.homeworkRepository.find({
      where: { lesson_id: lessonId },
      order: { created_at: 'ASC', id: 'ASC' },
      take: 500,
    });
    return homework.map((item) => {
      if (item.resource_url) {
        item.resource_url = buildAbsoluteUrl(
          this.apiOrigin,
          `/api/v1/teacher/lessons/${lessonId}/homework/${item.id}/resource`,
        );
      }
      return item;
    });
  }

  public async addHomework(
    lessonId: string,
    teacherId: string,
    dto: CreateHomeworkDto,
  ): Promise<LessonHomework> {
    await this.assertOwnedLesson(lessonId, teacherId);
    this.validateTeacherResourceReference(dto.resource_url, teacherId);
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
    const previousResource = homework.resource_url;
    if (dto.resource_url !== undefined) {
      this.validateTeacherResourceReference(dto.resource_url, teacherId);
      homework.resource_url = dto.resource_url;
    }
    if (dto.due_at !== undefined) {
      homework.due_at = dto.due_at ? new Date(dto.due_at) : null;
    }
    if (dto.questions !== undefined) homework.questions = this.normalizeQuestions(dto.questions);
    if (dto.max_score !== undefined) homework.max_score = dto.max_score;

    const saved = await this.homeworkRepository.save(homework);
    if (
      dto.resource_url !== undefined &&
      previousResource &&
      previousResource !== dto.resource_url
    ) {
      await this.storage.tryDelete(this.storage.toKey(previousResource));
    }
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
  public async listStudentHomework(
    studentId: string,
    page: number,
    limit: number,
  ): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> {
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
    const total = await qb.getCount();
    const rows = await qb
      .orderBy('homework.due_at', 'ASC', 'NULLS LAST')
      .addOrderBy('homework.published_at', 'DESC')
      .addOrderBy('homework.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    const data = rows.map((homework) => ({
      ...homework,
      resource_url: homework.resource_url
        ? buildAbsoluteUrl(this.apiOrigin, `/api/v1/student/homework/${homework.id}/resource`)
        : null,
      lesson: {
        id: homework.lesson.id,
        title: homework.lesson.title,
      },
      submission: homework.submissions[0]
        ? this.toStudentSubmissionResponse(homework.submissions[0])
        : null,
      submissions: undefined,
    }));
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
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
  ): Promise<Record<string, unknown>> {
    const homework = await this.assertStudentCanAccessHomework(studentId, homeworkId);
    this.validateHomeworkResponse(homework, dto);
    const resourceReference = dto.resource_url?.trim() || null;
    if (
      resourceReference !== null &&
      (resourceReference.includes('..') ||
        resourceReference.includes('\\') ||
        /^https?:\/\//iu.test(resourceReference) ||
        !resourceReference.startsWith(`homework-submissions/${studentId}/`))
    ) {
      throw new BadRequestException(
        biBody('Invalid private upload reference', 'Ù…Ø±Ø¬Ø¹ Ø§Ù„Ù…Ù„Ù Ø§Ù„Ø®Ø§Øµ ØºÙŠØ± ØµØ§Ù„Ø­'),
      );
    }

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
    const previousResource = existing?.resource_url ?? null;
    submission.resource_url = resourceReference;
    submission.status = 'submitted';
    submission.is_late = homework.due_at !== null && submittedAt > homework.due_at;
    submission.score = null;
    submission.feedback = null;
    submission.submitted_at = submittedAt;
    submission.graded_at = null;
    submission.graded_by = null;
    const saved = await this.homeworkSubmissions.save(submission);
    if (previousResource && previousResource !== resourceReference) {
      await this.storage.tryDelete(this.storage.toKey(previousResource));
    }
    return this.toStudentSubmissionResponse(saved);
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
        submission: submission
          ? {
              ...submission,
              resource_url: submission.resource_url
                ? buildAbsoluteUrl(
                    this.apiOrigin,
                    `/api/v1/teacher/lessons/${lessonId}/homework/${homeworkId}/submissions/${submission.id}/file`,
                  )
                : null,
            }
          : null,
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

  public async getHomeworkResourceForStudent(
    studentId: string,
    homeworkId: string,
  ): Promise<StoredObject> {
    const homework = await this.assertStudentCanAccessHomework(studentId, homeworkId);
    return this.fetchPrivateObject(homework.resource_url, 'Homework resource not found');
  }

  public async getHomeworkResourceForTeacher(
    teacherId: string,
    lessonId: string,
    homeworkId: string,
  ): Promise<StoredObject> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const homework = await this.homeworkRepository.findOne({
      where: { id: homeworkId, lesson_id: lessonId },
    });
    return this.fetchPrivateObject(homework?.resource_url ?? null, 'Homework resource not found');
  }

  public async getSubmissionFileForStudent(
    studentId: string,
    homeworkId: string,
  ): Promise<StoredObject> {
    await this.assertStudentCanAccessHomework(studentId, homeworkId);
    const submission = await this.homeworkSubmissions.findOne({
      where: { homework_id: homeworkId, student_id: studentId },
    });
    return this.fetchPrivateObject(submission?.resource_url ?? null, 'Submission file not found');
  }

  public async getSubmissionFileForTeacher(
    teacherId: string,
    lessonId: string,
    homeworkId: string,
    submissionId: string,
  ): Promise<StoredObject> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const homework = await this.homeworkRepository.findOne({
      where: { id: homeworkId, lesson_id: lessonId },
      select: { id: true },
    });
    if (!homework) {
      throw new NotFoundException(biBody('Homework not found', 'ÙˆØ§Ø¬Ø¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯'));
    }
    const submission = await this.homeworkSubmissions.findOne({
      where: { id: submissionId, homework_id: homeworkId },
    });
    return this.fetchPrivateObject(submission?.resource_url ?? null, 'Submission file not found');
  }

  private async fetchPrivateObject(
    reference: string | null,
    message: string,
  ): Promise<StoredObject> {
    if (!reference) throw new NotFoundException(message);
    try {
      return await this.storage.getObject(this.storage.toKey(reference));
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) throw new NotFoundException(message);
      throw error;
    }
  }

  private validateTeacherResourceReference(
    reference: string | null | undefined,
    teacherId: string,
  ): void {
    if (reference === null || reference === undefined || reference === '') return;
    if (
      reference.includes('..') ||
      reference.includes('\\') ||
      /^https?:\/\//iu.test(reference) ||
      !reference.startsWith(`lesson-resources/${teacherId}/`)
    ) {
      throw new BadRequestException(
        biBody('Invalid private upload reference', 'Ù…Ø±Ø¬Ø¹ Ø§Ù„Ù…Ù„Ù Ø§Ù„Ø®Ø§Øµ ØºÙŠØ± ØµØ§Ù„Ø­'),
      );
    }
  }

  private toStudentSubmissionResponse(submission: HomeworkSubmission): Record<string, unknown> {
    return {
      ...submission,
      resource_url: submission.resource_url
        ? buildAbsoluteUrl(
            this.apiOrigin,
            `/api/v1/student/homework/${submission.homework_id}/submission/file`,
          )
        : null,
    };
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
          AND lp.revoked_at IS NULL
          AND lp.access_expires_at > :accessNow
      ) OR EXISTS (
        SELECT 1 FROM package_purchases pp
        INNER JOIN lesson_package_items lpi ON lpi.package_id = pp.package_id
        WHERE pp.student_id = :studentId
          AND pp.revoked_at IS NULL
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
        .andWhere('purchase.revoked_at IS NULL')
        .andWhere('purchase.access_expires_at > :now', { now: new Date() })
        .select('purchase.student_id', 'student_id')
        .distinct(true)
        .getRawMany<{ student_id: string }>(),
      this.packagePurchases
        .createQueryBuilder('purchase')
        .innerJoin('purchase.package', 'package')
        .innerJoin('package.items', 'item', 'item.lesson_id = :lessonId', { lessonId })
        .where('purchase.revoked_at IS NULL')
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
