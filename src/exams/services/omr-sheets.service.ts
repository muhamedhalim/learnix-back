import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import {
  extensionMatchesMime,
  hasExpectedMagicBytes,
} from '../../common/utils/file-signature.util';
import { biBody } from '../../i18n/error-translator.util';
import { StoredObject, StorageObjectNotFoundError } from '../../storage/storage.interface';
import { StorageService } from '../../storage/storage.service';
import { CreateOmrSheetDto } from '../dto';
import { Exam, OmrSheet, OmrSheetStatus } from '../entities';
import { ExamJobsService } from './exam-jobs.service';
import { ExamAccessService } from './exam-access.service';

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
  'image_key' | 'exam' | 'student' | 'teacher' | 'attempt'
>;

/**
 * CRUD for OMR answer sheets — uploads the scan, records the (already
 * detected) marks, and enqueues processing. Contains NO grading/attempt logic
 * itself; that lives in `OmrProcessor` + `AttemptService`, reusing the
 * existing attempt/grading engine end to end.
 */
@Injectable()
export class OmrSheetsService {
  constructor(
    @InjectRepository(Exam) private readonly exams: Repository<Exam>,
    @InjectRepository(OmrSheet) private readonly sheets: Repository<OmrSheet>,
    private readonly storage: StorageService,
    private readonly jobs: ExamJobsService,
    private readonly access: ExamAccessService,
  ) {}

  public async create(
    examId: string,
    teacherId: string,
    dto: CreateOmrSheetDto,
    file: MulterFile | undefined,
  ): Promise<OmrSheetResponse> {
    await this.assertOwned(examId, teacherId);
    await this.access.assertCanAccessPrivateExam(dto.student_id, examId);

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
    if (dto.answers.length === 0) {
      throw new BadRequestException(
        biBody('No detected answers provided', 'لم يتم تقديم أي إجابات مكتشفة'),
      );
    }

    const key = `omr-sheets/${randomUUID()}${extname(file.originalname) || '.jpg'}`;
    const stored = await this.storage.upload({
      buffer: file.buffer,
      path: key,
      contentType: file.mimetype,
      visibility: 'private',
    });

    const sheet = this.sheets.create({
      exam_id: examId,
      student_id: dto.student_id,
      teacher_id: teacherId,
      image_key: stored.path,
      detected_answers: dto.answers.map((a) => ({
        exam_question_id: a.exam_question_id,
        response: a.response ?? null,
      })),
      status: OmrSheetStatus.PENDING,
    });
    const saved = await this.sheets.save(sheet);
    await this.jobs.enqueueOmrProcessing(saved.id);
    return this.toResponse(saved);
  }

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
    try {
      return await this.storage.getObject(this.storage.toKey(sheet.image_key));
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        throw new NotFoundException(biBody('OMR image not found', 'OMR image not found'));
      }
      throw error;
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
      detected_answers: sheet.detected_answers,
      status: sheet.status,
      error_message: sheet.error_message,
      attempt_id: sheet.attempt_id,
      processed_at: sheet.processed_at,
      created_at: sheet.created_at,
      updated_at: sheet.updated_at,
    };
  }

  private async assertOwned(examId: string, teacherId: string): Promise<void> {
    const exam = await this.exams.findOne({
      where: { id: examId, teacher_id: teacherId, deleted_at: IsNull() },
    });
    if (!exam) throw new NotFoundException(biBody('Exam not found', 'الاختبار غير موجود'));
  }
}
