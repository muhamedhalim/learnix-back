import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, In, IsNull, Not, Repository } from 'typeorm';

import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import {
  extensionMatchesMime,
  hasExpectedMagicBytes,
} from '../../common/utils/file-signature.util';
import { biBody } from '../../i18n/error-translator.util';
import { StoredObject, StorageObjectNotFoundError } from '../../storage/storage.interface';
import { StorageService } from '../../storage/storage.service';
import { User } from '../../users/entities/user.entity';
import { GenerateOmrSheetsDto, PatchOmrAnswerDto, ScanOmrSheetDto } from '../dto';
import {
  AttemptState,
  Exam,
  ExamQuestion,
  ExamStatus,
  markNeedsReview,
  OmrSheet,
  OmrSheetStatus,
  OMR_SHEET_MUTABLE_STATUSES,
  OMR_SHEET_TERMINAL_STATUSES,
  OmrTemplate,
} from '../entities';
import type { OmrDetectedAnswer } from '../entities/omr-sheet.entity';
import { decodeSheetIdFromQrPayload, detectQr } from '../omr-recognition/qr.util';
import { decodeToRaster } from '../omr-recognition/image-buffer.util';
import { QR_SEARCH_MAX_DIMENSION_PX } from '../omr-recognition/constants';
import { QuestionTypeRegistry } from '../question-types/question-type-registry';
import { AttemptService, type SubmissionSummary } from './attempt.service';
import { ExamAccessService } from './exam-access.service';
import { ExamJobsService } from './exam-jobs.service';
import { OmrSheetPdfService } from './omr-sheet-pdf.service';
import { OmrTemplatesService } from './omr-templates.service';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const OMR_IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

interface MulterFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export type OmrSheetResponse = Omit<
  OmrSheet,
  | 'image_key'
  | 'exam'
  | 'student'
  | 'teacher'
  | 'template'
  | 'reviewer'
  | 'attempt'
  | 'recognized_answers'
> & { has_image: boolean };

export interface OmrSheetReviewQuestion {
  exam_question_id: string;
  label: number;
  type: string;
  content: Record<string, unknown>;
  status: string;
  /** 0..1 — surfaced to the teacher as a simple confidence indicator, never raw fill-ratio data. */
  confidence: number;
  detected: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
  needs_review: boolean;
  resolved: boolean;
}

export interface OmrSheetReviewResponse {
  sheet: OmrSheetResponse;
  answers: OmrSheetReviewQuestion[];
}

export interface OmrConfirmResult {
  sheet: OmrSheetResponse;
  attempt: SubmissionSummary | null;
}

/**
 * Teacher-facing OMR workflow: generate templated sheets, accept scans, drive
 * the review/confirm lifecycle, and hand confirmed answers to the EXISTING
 * attempt/grading engine (`AttemptService`) — this service contains no
 * grading logic of its own. Image recognition itself lives in `OmrProcessor`
 * + the `omr-recognition/` module; this service only orchestrates state.
 */
@Injectable()
export class OmrSheetsService {
  constructor(
    @InjectRepository(Exam) private readonly exams: Repository<Exam>,
    @InjectRepository(OmrSheet) private readonly sheets: Repository<OmrSheet>,
    @InjectRepository(OmrTemplate) private readonly templates: Repository<OmrTemplate>,
    @InjectRepository(ExamQuestion) private readonly examQuestions: Repository<ExamQuestion>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly jobs: ExamJobsService,
    private readonly access: ExamAccessService,
    private readonly templatesService: OmrTemplatesService,
    private readonly attemptService: AttemptService,
    private readonly questionTypes: QuestionTypeRegistry,
    private readonly pdfService: OmrSheetPdfService,
  ) {}

  // ==================== GENERATE / DOWNLOAD ====================

  public async generate(
    examId: string,
    teacherId: string,
    dto: GenerateOmrSheetsDto,
  ): Promise<OmrSheetResponse[]> {
    await this.assertOwned(examId, teacherId);
    const template = await this.templatesService.getOrCreateForExam(examId, teacherId);

    const results: OmrSheet[] = [];
    for (const studentId of new Set(dto.student_ids)) {
      await this.access.assertCanAccessPrivateExam(studentId, examId);
      results.push(await this.getOrCreateActiveSheet(examId, teacherId, studentId, template.id));
    }
    return results.map((s) => this.toResponse(s));
  }

  public async getSheetPdf(
    examId: string,
    teacherId: string,
    sheetId: string,
    locale: 'en' | 'ar',
  ): Promise<Buffer> {
    const sheet = await this.findEntity(examId, teacherId, sheetId);
    const template = await this.requireTemplate(sheet.template_id);
    const exam = await this.exams.findOneOrFail({ where: { id: examId } });
    const student = await this.users.findOneOrFail({ where: { id: sheet.student_id } });
    const examQuestions = await this.examQuestions.find({
      where: { exam_id: examId, id: In(template.layout.questions.map((q) => q.examQuestionId)) },
    });

    return this.pdfService.render({
      sheetId: sheet.id,
      template: template.layout,
      examTitle: { en: exam.title, ar: exam.title_ar },
      studentName: student.name,
      examQuestions,
      locale,
    });
  }

  // ==================== SCAN ====================

  public async scan(
    examId: string,
    teacherId: string,
    dto: ScanOmrSheetDto,
    file: MulterFile | undefined,
  ): Promise<OmrSheetResponse> {
    await this.assertOwned(examId, teacherId);
    this.validateFile(file);
    const uploadedFile = file!;

    let sheet: OmrSheet | null = null;
    if (dto.sheet_id) {
      sheet = await this.sheets.findOne({ where: { id: dto.sheet_id, exam_id: examId } });
      if (!sheet)
        throw new NotFoundException(biBody('OMR sheet not found', 'ورقة الإجابة غير موجودة'));
    } else {
      const autoResolvedId = await this.tryResolveSheetIdFromQr(uploadedFile.buffer, examId);
      if (autoResolvedId) {
        sheet = await this.sheets.findOne({ where: { id: autoResolvedId, exam_id: examId } });
      }
    }

    if (!sheet) {
      if (!dto.student_id) {
        throw new BadRequestException(
          biBody(
            'Could not identify which student this scan belongs to — provide sheet_id or student_id, or use a Learnix-generated sheet with its QR code intact',
            'تعذر تحديد الطالب صاحب هذه الورقة — يرجى تحديد sheet_id أو student_id، أو استخدام ورقة تم إنشاؤها بواسطة Learnix مع رمز QR سليم',
          ),
        );
      }
      await this.access.assertCanAccessPrivateExam(dto.student_id, examId);
      const template = await this.templatesService.getOrCreateForExam(examId, teacherId);
      sheet = await this.getOrCreateActiveSheet(examId, teacherId, dto.student_id, template.id);
    }

    if (!(OMR_SHEET_MUTABLE_STATUSES as readonly OmrSheetStatus[]).includes(sheet.status)) {
      throw new ConflictException(
        biBody(
          `Sheet is ${sheet.status}; a new scan cannot be uploaded`,
          `الورقة في حالة ${sheet.status}؛ لا يمكن رفع مسح جديد`,
        ),
      );
    }

    const key = `omr-sheets/${randomUUID()}${extname(uploadedFile.originalname) || '.jpg'}`;
    const stored = await this.storage.upload({
      buffer: uploadedFile.buffer,
      path: key,
      contentType: uploadedFile.mimetype,
      visibility: 'private',
    });

    this.resetRecognitionState(sheet);
    sheet.image_key = stored.path;
    const saved = await this.sheets.save(sheet);
    await this.jobs.enqueueOmrProcessing(saved.id);
    return this.toResponse(saved);
  }

  // ==================== REVIEW / CORRECT / CONFIRM ====================

  public async getReview(
    examId: string,
    teacherId: string,
    sheetId: string,
  ): Promise<OmrSheetReviewResponse> {
    const sheet = await this.findEntity(examId, teacherId, sheetId);
    const template = await this.requireTemplate(sheet.template_id);
    const examQuestions = await this.examQuestions.find({
      where: { exam_id: examId, id: In(template.layout.questions.map((q) => q.examQuestionId)) },
    });
    const contentById = new Map(examQuestions.map((eq) => [eq.id, eq]));
    const recognizedById = new Map(
      (sheet.recognized_answers ?? []).map((r) => [r.exam_question_id, r]),
    );
    const detectedById = new Map(
      (sheet.detected_answers ?? []).map((d) => [d.exam_question_id, d]),
    );

    const answers: OmrSheetReviewQuestion[] = template.layout.questions.map((q) => {
      const recognized = recognizedById.get(q.examQuestionId);
      return {
        exam_question_id: q.examQuestionId,
        label: q.label,
        type: q.type,
        content: contentById.get(q.examQuestionId)?.content_snapshot ?? {},
        status: recognized?.status ?? 'blank',
        confidence: recognized?.confidence ?? 0,
        detected: recognized?.detected ?? null,
        current: detectedById.get(q.examQuestionId)?.response ?? null,
        needs_review: recognized ? markNeedsReview(recognized) : false,
        resolved: sheet.resolved_question_ids.includes(q.examQuestionId),
      };
    });

    return { sheet: this.toResponse(sheet), answers };
  }

  public async patchAnswer(
    examId: string,
    teacherId: string,
    sheetId: string,
    examQuestionId: string,
    dto: PatchOmrAnswerDto,
  ): Promise<OmrSheetResponse> {
    const sheet = await this.findEntity(examId, teacherId, sheetId);
    if (sheet.status !== OmrSheetStatus.READY && sheet.status !== OmrSheetStatus.REVIEW_REQUIRED) {
      throw new ConflictException(
        biBody(
          `Sheet is ${sheet.status}; answers can no longer be edited`,
          `الورقة في حالة ${sheet.status}؛ لا يمكن تعديل الإجابات الآن`,
        ),
      );
    }

    const template = await this.requireTemplate(sheet.template_id);
    const layoutQuestion = template.layout.questions.find(
      (q) => q.examQuestionId === examQuestionId,
    );
    if (!layoutQuestion) {
      throw new BadRequestException(
        biBody('This question is not part of this sheet', 'هذا السؤال ليس جزءًا من هذه الورقة'),
      );
    }

    if (dto.response !== null) {
      const examQuestion = await this.examQuestions.findOne({
        where: { id: examQuestionId, exam_id: examId },
      });
      if (!examQuestion)
        throw new NotFoundException(biBody('Question not found', 'السؤال غير موجود'));
      const errors = this.questionTypes
        .require(examQuestion.type_snapshot)
        .validateResponse(dto.response);
      if (errors.length > 0) {
        throw new BadRequestException({
          message: 'Invalid answer payload',
          exam_question_id: examQuestionId,
          errors,
        });
      }
    }

    const currentAnswers = [...(sheet.detected_answers ?? [])];
    const index = currentAnswers.findIndex((a) => a.exam_question_id === examQuestionId);
    const updated: OmrDetectedAnswer = { exam_question_id: examQuestionId, response: dto.response };
    if (index >= 0) currentAnswers[index] = updated;
    else currentAnswers.push(updated);

    sheet.detected_answers = currentAnswers;
    if (!sheet.resolved_question_ids.includes(examQuestionId)) {
      sheet.resolved_question_ids = [...sheet.resolved_question_ids, examQuestionId];
    }
    const saved = await this.sheets.save(sheet);
    return this.toResponse(saved);
  }

  /**
   * Sequential and idempotent, NOT one atomic transaction (matching how
   * `OmrProcessor`/`AttemptService` already operate — each step commits on
   * its own and is safe to retry from scratch): lock+guard+flip the sheet to
   * CONFIRMED first; only then call into `AttemptService`, so a crash between
   * the two leaves the sheet in CONFIRMED (not READY/REVIEW_REQUIRED), and a
   * retried `confirm()` call resumes cleanly instead of re-validating review
   * state or double-grading.
   */
  public async confirm(
    examId: string,
    teacherId: string,
    sheetId: string,
  ): Promise<OmrConfirmResult> {
    const exam = await this.assertOwned(examId, teacherId);

    const sheet = await this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOne(OmrSheet, {
        where: { id: sheetId, exam_id: examId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked)
        throw new NotFoundException(biBody('OMR sheet not found', 'ورقة الإجابة غير موجودة'));
      if (locked.status === OmrSheetStatus.COMPLETED) return locked; // idempotent replay

      if (
        locked.status !== OmrSheetStatus.READY &&
        locked.status !== OmrSheetStatus.REVIEW_REQUIRED &&
        locked.status !== OmrSheetStatus.CONFIRMED
      ) {
        throw new ConflictException(
          biBody(
            `Sheet is ${locked.status}; it cannot be confirmed yet`,
            `الورقة في حالة ${locked.status}؛ لا يمكن تأكيدها الآن`,
          ),
        );
      }

      if (locked.status !== OmrSheetStatus.CONFIRMED) {
        const unresolved = (locked.recognized_answers ?? [])
          .filter(markNeedsReview)
          .filter((a) => !locked.resolved_question_ids.includes(a.exam_question_id));
        if (unresolved.length > 0) {
          throw new BadRequestException(
            biBody(
              `${String(unresolved.length)} question(s) still need review before this sheet can be confirmed`,
              `لا يزال هناك ${String(unresolved.length)} سؤال يحتاج مراجعة قبل تأكيد هذه الورقة`,
            ),
          );
        }
        locked.status = OmrSheetStatus.CONFIRMED;
        locked.confirmed_at = new Date();
        locked.reviewed_by = teacherId;
        await manager.save(OmrSheet, locked);
      }
      return locked;
    });

    if (sheet.status === OmrSheetStatus.COMPLETED) {
      return {
        sheet: this.toResponse(sheet),
        attempt: await this.summarizeAttempt(sheet.attempt_id),
      };
    }

    // Grading a DRAFT/ARCHIVED exam is never valid — unlike the online flow,
    // this deliberately does NOT check the exam's start/end window: OMR
    // confirmation routinely happens well after a paper exam's class time,
    // which is often after any online window would already be closed.
    if (exam.status !== ExamStatus.PUBLISHED && exam.status !== ExamStatus.SCHEDULED) {
      throw new ForbiddenException(
        biBody('This exam is not available for grading', 'هذا الاختبار غير متاح للتصحيح'),
      );
    }

    const attempt = await this.attemptService.createOmrAttempt(examId, sheet.student_id);
    let summary: SubmissionSummary;
    if (attempt.state === AttemptState.IN_PROGRESS) {
      await this.attemptService.saveAnswers(sheet.student_id, attempt.id, {
        answers: (sheet.detected_answers ?? []).map((a) => ({
          exam_question_id: a.exam_question_id,
          response: a.response,
        })),
      });
      summary = await this.attemptService.submit(sheet.student_id, attempt.id, { answers: [] });
    } else {
      // createOmrAttempt reused a pre-existing 'omr'-origin attempt that was
      // already finalised — reflect its real state (incl. pending_manual for
      // any essay questions on a mixed exam) rather than re-deriving it here.
      summary = (await this.attemptService.getSummary(attempt.id))!;
    }

    sheet.status = OmrSheetStatus.COMPLETED;
    sheet.attempt_id = attempt.id;
    sheet.processed_at = sheet.processed_at ?? new Date();
    await this.sheets.save(sheet);

    return { sheet: this.toResponse(sheet), attempt: summary };
  }

  public async reprocess(
    examId: string,
    teacherId: string,
    sheetId: string,
  ): Promise<OmrSheetResponse> {
    const sheet = await this.findEntity(examId, teacherId, sheetId);
    if (sheet.status === OmrSheetStatus.CONFIRMED || sheet.status === OmrSheetStatus.COMPLETED) {
      throw new ConflictException(
        biBody(
          'This sheet has already been confirmed and cannot be reprocessed',
          'تم تأكيد هذه الورقة بالفعل ولا يمكن إعادة معالجتها',
        ),
      );
    }
    if (!sheet.image_key) {
      throw new BadRequestException(
        biBody(
          'This sheet has no scanned image to reprocess',
          'لا توجد صورة ممسوحة ضوئيًا لهذه الورقة لإعادة معالجتها',
        ),
      );
    }
    this.resetRecognitionState(sheet);
    const saved = await this.sheets.save(sheet);
    await this.jobs.enqueueOmrProcessing(saved.id);
    return this.toResponse(saved);
  }

  // ==================== READ ====================

  public async findMany(
    examId: string,
    teacherId: string,
    page: number,
    limit: number,
  ): Promise<{ data: OmrSheetResponse[]; meta: PaginationMeta }> {
    await this.assertOwned(examId, teacherId);
    const [rows, total] = await this.sheets.findAndCount({
      where: { exam_id: examId },
      order: { created_at: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const totalPages = Math.ceil(total / limit);
    return {
      data: rows.map((sheet) => this.toResponse(sheet)),
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

  public async findOne(
    examId: string,
    teacherId: string,
    sheetId: string,
  ): Promise<OmrSheetResponse> {
    return this.toResponse(await this.findEntity(examId, teacherId, sheetId));
  }

  public async getImageObject(
    examId: string,
    teacherId: string,
    sheetId: string,
  ): Promise<StoredObject> {
    const sheet = await this.findEntity(examId, teacherId, sheetId);
    if (!sheet.image_key) {
      throw new NotFoundException(
        biBody('This sheet has not been scanned yet', 'لم يتم مسح هذه الورقة بعد'),
      );
    }
    try {
      return await this.storage.getObject(this.storage.toKey(sheet.image_key));
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        throw new NotFoundException(biBody('OMR image not found', 'OMR image not found'));
      }
      throw error;
    }
  }

  // ==================== HELPERS ====================

  private async getOrCreateActiveSheet(
    examId: string,
    teacherId: string,
    studentId: string,
    templateId: string,
  ): Promise<OmrSheet> {
    const existing = await this.sheets.findOne({
      where: {
        exam_id: examId,
        student_id: studentId,
        status: Not(In([...OMR_SHEET_TERMINAL_STATUSES])),
      },
    });
    if (existing) return existing;

    const created = this.sheets.create({
      exam_id: examId,
      student_id: studentId,
      teacher_id: teacherId,
      template_id: templateId,
      status: OmrSheetStatus.PENDING,
      resolved_question_ids: [],
    });
    try {
      return await this.sheets.save(created);
    } catch (err) {
      if (this.isActiveSheetConflict(err)) {
        const raced = await this.sheets.findOne({
          where: {
            exam_id: examId,
            student_id: studentId,
            status: Not(In([...OMR_SHEET_TERMINAL_STATUSES])),
          },
        });
        if (raced) return raced;
      }
      throw err;
    }
  }

  private isActiveSheetConflict(err: unknown): boolean {
    const e = err as {
      code?: string;
      constraint?: string;
      driverError?: { code?: string; constraint?: string };
    };
    const code = e.code ?? e.driverError?.code;
    const constraint = e.constraint ?? e.driverError?.constraint;
    return code === '23505' && constraint === 'UQ_omr_sheets_active_per_student';
  }

  private async tryResolveSheetIdFromQr(buffer: Buffer, examId: string): Promise<string | null> {
    try {
      const raster = await decodeToRaster(buffer, QR_SEARCH_MAX_DIMENSION_PX);
      const qr = detectQr(raster.rgba, raster.width, raster.height);
      if (!qr) return null;
      const sheetId = decodeSheetIdFromQrPayload(qr.data);
      if (!sheetId) return null;
      const sheet = await this.sheets.findOne({ where: { id: sheetId, exam_id: examId } });
      return sheet ? sheetId : null;
    } catch {
      return null; // best-effort routing hint only
    }
  }

  private resetRecognitionState(sheet: OmrSheet): void {
    sheet.status = OmrSheetStatus.PENDING;
    sheet.recognized_answers = null;
    sheet.detected_answers = null;
    sheet.resolved_question_ids = [];
    sheet.error_message = null;
    sheet.confirmed_at = null;
    sheet.reviewed_by = null;
  }

  private async summarizeAttempt(attemptId: string | null): Promise<SubmissionSummary | null> {
    if (!attemptId) return null;
    return this.attemptService.getSummary(attemptId);
  }

  private async requireTemplate(templateId: string | null): Promise<OmrTemplate> {
    if (!templateId) {
      throw new BadRequestException(
        biBody(
          'This sheet has no OMR template bound to it',
          'لا يوجد قالب ورقة إجابة مرتبط بهذه الورقة',
        ),
      );
    }
    const template = await this.templates.findOne({ where: { id: templateId } });
    if (!template) {
      throw new NotFoundException(biBody('OMR template not found', 'قالب ورقة الإجابة غير موجود'));
    }
    return template;
  }

  private validateFile(file: MulterFile | undefined): asserts file is MulterFile {
    if (!file) {
      throw new BadRequestException(
        biBody('No answer sheet image provided', 'لم يتم تقديم صورة ورقة الإجابة'),
      );
    }
    if (!IMAGE_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        biBody(
          `Unsupported image type: ${file.mimetype}`,
          `نوع الصورة غير مدعوم: ${file.mimetype}`,
        ),
      );
    }
    if (
      file.originalname.includes('..') ||
      file.originalname.includes('/') ||
      file.originalname.includes('\\') ||
      !extensionMatchesMime(file.originalname, file.mimetype) ||
      !hasExpectedMagicBytes(file.mimetype, file.buffer)
    ) {
      throw new BadRequestException(
        biBody('Invalid answer sheet image', 'Invalid answer sheet image'),
      );
    }
    if (file.size > OMR_IMAGE_MAX_BYTES) {
      throw new BadRequestException(
        biBody(
          `Image too large (max ${String(OMR_IMAGE_MAX_BYTES / (1024 * 1024))} MB)`,
          `حجم الصورة كبير جدًا (الحد الأقصى ${String(OMR_IMAGE_MAX_BYTES / (1024 * 1024))} ميجابايت)`,
        ),
      );
    }
  }

  private async findEntity(examId: string, teacherId: string, sheetId: string): Promise<OmrSheet> {
    await this.assertOwned(examId, teacherId);
    const sheet = await this.sheets.findOne({ where: { id: sheetId, exam_id: examId } });
    if (!sheet)
      throw new NotFoundException(biBody('OMR sheet not found', 'ورقة الإجابة غير موجودة'));
    return sheet;
  }

  private toResponse(sheet: OmrSheet): OmrSheetResponse {
    return {
      id: sheet.id,
      exam_id: sheet.exam_id,
      student_id: sheet.student_id,
      teacher_id: sheet.teacher_id,
      template_id: sheet.template_id,
      has_image: sheet.image_key !== null,
      detected_answers: sheet.detected_answers,
      resolved_question_ids: sheet.resolved_question_ids,
      recognition_provider: sheet.recognition_provider,
      status: sheet.status,
      error_message: sheet.error_message,
      attempt_id: sheet.attempt_id,
      confirmed_at: sheet.confirmed_at,
      reviewed_by: sheet.reviewed_by,
      processed_at: sheet.processed_at,
      created_at: sheet.created_at,
      updated_at: sheet.updated_at,
    };
  }

  private async assertOwned(examId: string, teacherId: string): Promise<Exam> {
    const exam = await this.exams.findOne({
      where: { id: examId, teacher_id: teacherId, deleted_at: IsNull() },
    });
    if (!exam) throw new NotFoundException(biBody('Exam not found', 'الاختبار غير موجود'));
    return exam;
  }
}
