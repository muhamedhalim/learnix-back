import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { Exam, ExamQuestion, OmrTemplate } from '../entities';
import {
  computeOmrContentHash,
  generateOmrTemplateLayout,
  OmrLayoutError,
} from '../omr-recognition/template-layout.util';

/**
 * Get-or-create OMR template per exam. A template is regenerated (new
 * version) only when the exam's OMR-relevant question set actually changed
 * (`content_hash` mismatch) — sheets already bound to an older version stay
 * valid against exactly the layout they were printed from (`OmrSheet.template_id`),
 * so editing an exam after printing never corrupts an in-flight scan.
 */
@Injectable()
export class OmrTemplatesService {
  constructor(
    @InjectRepository(Exam) private readonly exams: Repository<Exam>,
    @InjectRepository(ExamQuestion) private readonly examQuestions: Repository<ExamQuestion>,
    @InjectRepository(OmrTemplate) private readonly templates: Repository<OmrTemplate>,
  ) {}

  /** Returns the current (possibly freshly generated) template for an exam. Throws on OMR-ineligible exams. */
  public async getOrCreateForExam(examId: string, teacherId: string): Promise<OmrTemplate> {
    await this.assertOwned(examId, teacherId);
    const examQuestions = await this.examQuestions.find({ where: { exam_id: examId } });
    const contentHash = computeOmrContentHash(examQuestions);

    const latest = await this.templates.findOne({
      where: { exam_id: examId },
      order: { version: 'DESC' },
    });
    if (latest && latest.content_hash === contentHash) return latest;

    let layout;
    try {
      layout = generateOmrTemplateLayout(examQuestions);
    } catch (err) {
      if (err instanceof OmrLayoutError) {
        throw new BadRequestException(biBody(err.message, err.message));
      }
      throw err;
    }

    const created = this.templates.create({
      exam_id: examId,
      version: (latest?.version ?? 0) + 1,
      content_hash: contentHash,
      layout,
      created_by: teacherId,
    });
    return this.templates.save(created);
  }

  public async findOwned(
    templateId: string,
    examId: string,
    teacherId: string,
  ): Promise<OmrTemplate> {
    await this.assertOwned(examId, teacherId);
    const template = await this.templates.findOne({ where: { id: templateId, exam_id: examId } });
    if (!template) {
      throw new NotFoundException(biBody('OMR template not found', 'قالب ورقة الإجابة غير موجود'));
    }
    return template;
  }

  private async assertOwned(examId: string, teacherId: string): Promise<Exam> {
    const exam = await this.exams.findOne({
      where: { id: examId, teacher_id: teacherId, deleted_at: IsNull() },
    });
    if (!exam) throw new NotFoundException(biBody('Exam not found', 'الاختبار غير موجود'));
    return exam;
  }
}
