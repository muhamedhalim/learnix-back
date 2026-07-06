import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { PaginatedResponse, PaginationMeta } from '../../common/interfaces/pagination.interface';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { Subject } from '../../subjects/entities/subject.entity';
import {
  AttachQuestionDto,
  CreateExamDto,
  ExamFilterDto,
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
  constructor(
    @InjectRepository(Exam) private readonly exams: Repository<Exam>,
    @InjectRepository(ExamSection) private readonly sections: Repository<ExamSection>,
    @InjectRepository(ExamQuestion) private readonly examQuestions: Repository<ExamQuestion>,
    @InjectRepository(Question) private readonly questions: Repository<Question>,
    @InjectRepository(Subject) private readonly subjects: Repository<Subject>,
    @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
    private readonly dataSource: DataSource,
  ) {}

  public async createExam(teacherId: string, dto: CreateExamDto): Promise<Exam> {
    await this.assertSubject(dto.subject_id);
    if (dto.lesson_id !== undefined) await this.assertLesson(dto.lesson_id);

    const exam = this.exams.create({
      teacher_id: teacherId,
      subject_id: dto.subject_id,
      lesson_id: dto.lesson_id ?? null,
      title: dto.title,
      title_ar: dto.title_ar,
      description: dto.description ?? null,
      description_ar: dto.description_ar ?? null,
      status: ExamStatus.DRAFT,
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
    if (dto.lesson_id !== undefined) await this.assertLesson(dto.lesson_id);

    Object.assign(exam, {
      title: dto.title ?? exam.title,
      title_ar: dto.title_ar ?? exam.title_ar,
      description: dto.description ?? exam.description,
      description_ar: dto.description_ar ?? exam.description_ar,
      subject_id: dto.subject_id ?? exam.subject_id,
      lesson_id: dto.lesson_id ?? exam.lesson_id,
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
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.teacher_id !== teacherId) throw new ForbiddenException('Not your exam');
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
    if (!section) throw new BadRequestException('Section does not belong to this exam');

    const question = await this.questions.findOne({
      where: { id: dto.question_id, deleted_at: IsNull() },
    });
    if (!question) throw new NotFoundException('Question not found');
    if (question.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only add your own questions');
    }

    const duplicate = await this.examQuestions.findOne({
      where: { exam_id: examId, question_id: dto.question_id },
    });
    if (duplicate) throw new BadRequestException('Question is already in this exam');

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

  // ---- lifecycle ----

  public async publish(examId: string, teacherId: string): Promise<Exam> {
    const exam = await this.findOwned(examId, teacherId);
    if (exam.status !== ExamStatus.DRAFT) {
      throw new BadRequestException(`Only a draft exam can be published (current: ${exam.status})`);
    }
    const questionCount = await this.examQuestions.count({ where: { exam_id: examId } });
    if (questionCount === 0) {
      throw new BadRequestException('Cannot publish an exam with no questions');
    }
    if (exam.passing_marks > exam.total_marks) {
      throw new BadRequestException(
        `Passing marks (${String(exam.passing_marks)}) exceed total marks (${String(exam.total_marks)})`,
      );
    }
    const start = exam.config.start_window_at;
    const scheduled = start !== null && start !== undefined && new Date(start).getTime() > Date.now();
    exam.status = scheduled ? ExamStatus.SCHEDULED : ExamStatus.PUBLISHED;
    return this.exams.save(exam);
  }

  public async archive(examId: string, teacherId: string): Promise<Exam> {
    const exam = await this.findOwned(examId, teacherId);
    exam.status = ExamStatus.ARCHIVED;
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
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.teacher_id !== teacherId) throw new ForbiddenException('You can only manage your own exams');
    return exam;
  }

  private assertDraft(exam: Exam): void {
    if (exam.status !== ExamStatus.DRAFT) {
      throw new BadRequestException('Exam structure can only be edited while it is a draft');
    }
  }

  private mergeConfig(base: ExamConfig, patch?: Partial<ExamConfig>): ExamConfig {
    return { ...base, ...(patch ?? {}) };
  }

  private async assertSubject(subjectId: string): Promise<void> {
    const exists = await this.subjects.findOne({ where: { id: subjectId, deleted_at: IsNull() } });
    if (!exists) throw new NotFoundException(`Subject ${subjectId} not found`);
  }

  private async assertLesson(lessonId: string): Promise<void> {
    const exists = await this.lessons.findOne({ where: { id: lessonId, deleted_at: IsNull() } });
    if (!exists) throw new NotFoundException(`Lesson ${lessonId} not found`);
  }

  private meta(total: number, page: number, limit: number): PaginationMeta {
    const totalPages = Math.ceil(total / limit);
    return { total, page, limit, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 };
  }
}
