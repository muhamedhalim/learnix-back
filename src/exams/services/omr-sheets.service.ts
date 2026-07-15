import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { StorageService } from '../../storage/storage.service';
import { CreateOmrSheetDto } from '../dto';
import { Exam, OmrSheet, OmrSheetStatus } from '../entities';
import { ExamJobsService } from './exam-jobs.service';
import { ExamAccessService } from './exam-access.service';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

interface MulterFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

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
  ): Promise<OmrSheet> {
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
    if (file.size > MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        biBody(
          `Image too large (max ${String(MAX_IMAGE_BYTES / (1024 * 1024))} MB)`,
          `حجم الصورة كبير جدًا (الحد الأقصى ${String(MAX_IMAGE_BYTES / (1024 * 1024))} ميجابايت)`,
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
    return saved;
  }

  public async findMany(examId: string, teacherId: string): Promise<OmrSheet[]> {
    await this.assertOwned(examId, teacherId);
    return this.sheets.find({ where: { exam_id: examId }, order: { created_at: 'DESC' } });
  }

  public async findOne(examId: string, teacherId: string, sheetId: string): Promise<OmrSheet> {
    await this.assertOwned(examId, teacherId);
    const sheet = await this.sheets.findOne({ where: { id: sheetId, exam_id: examId } });
    if (!sheet)
      throw new NotFoundException(biBody('OMR sheet not found', 'ورقة الإجابة غير موجودة'));
    return sheet;
  }

  private async assertOwned(examId: string, teacherId: string): Promise<void> {
    const exam = await this.exams.findOne({ where: { id: examId, deleted_at: IsNull() } });
    if (!exam) throw new NotFoundException(biBody('Exam not found', 'الاختبار غير موجود'));
    if (exam.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only manage your own exams', 'يمكنك فقط إدارة اختباراتك الخاصة'),
      );
    }
  }
}
