import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, IsNull, Repository } from 'typeorm';

import { PaginatedResponse, PaginationMeta } from '../../common/interfaces/pagination.interface';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { Subject } from '../../subjects/entities/subject.entity';
import { CreateQuestionDto, QuestionFilterDto, UpdateQuestionDto } from '../dto';
import { Question, QuestionType, QuestionVersion } from '../entities';
import { QuestionTypeRegistry } from '../question-types/question-type-registry';

/**
 * Question Bank service: CRUD + immutable versioning for reusable questions.
 * All type-specific payload validation is delegated to the question-type
 * registry, so the bank never branches on the concrete type.
 */
@Injectable()
export class QuestionBankService {
  constructor(
    @InjectRepository(Question) private readonly questions: Repository<Question>,
    @InjectRepository(QuestionVersion) private readonly versions: Repository<QuestionVersion>,
    @InjectRepository(Subject) private readonly subjects: Repository<Subject>,
    @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
    private readonly registry: QuestionTypeRegistry,
    private readonly dataSource: DataSource,
  ) {}

  /** Create a bank question and snapshot version 1. */
  public async create(teacherId: string, dto: CreateQuestionDto): Promise<Question> {
    await this.assertSubject(dto.subject_id);
    if (dto.lesson_id !== undefined) await this.assertLesson(dto.lesson_id);
    this.validatePayload(dto.type, dto.content, dto.answer_key);

    return this.dataSource.transaction(async (manager) => {
      const question = manager.create(Question, {
        teacher_id: teacherId,
        subject_id: dto.subject_id,
        lesson_id: dto.lesson_id ?? null,
        chapter: dto.chapter ?? null,
        topic: dto.topic ?? null,
        type: dto.type,
        difficulty: dto.difficulty ?? null,
        bloom_level: dto.bloom_level ?? null,
        content: dto.content,
        answer_key: dto.answer_key,
        default_marks: dto.default_marks,
        tags: dto.tags ?? [],
        current_version: 1,
      });
      const saved = await manager.save(Question, question);
      await manager.save(
        QuestionVersion,
        manager.create(QuestionVersion, {
          question_id: saved.id,
          version: 1,
          type: saved.type,
          content: saved.content,
          answer_key: saved.answer_key,
          default_marks: saved.default_marks,
          created_by: teacherId,
        }),
      );
      return saved;
    });
  }

  /** Update a question; edits to content/answer_key/marks cut a new version. */
  public async update(id: string, teacherId: string, dto: UpdateQuestionDto): Promise<Question> {
    const question = await this.findOwned(id, teacherId);

    if (dto.subject_id !== undefined) await this.assertSubject(dto.subject_id);
    if (dto.lesson_id !== undefined) await this.assertLesson(dto.lesson_id);

    const nextContent = dto.content ?? question.content;
    const nextAnswerKey = dto.answer_key ?? question.answer_key;
    const contentChanged =
      dto.content !== undefined || dto.answer_key !== undefined || dto.default_marks !== undefined;

    if (dto.content !== undefined || dto.answer_key !== undefined) {
      this.validatePayload(question.type, nextContent, nextAnswerKey);
    }

    return this.dataSource.transaction(async (manager) => {
      Object.assign(question, {
        subject_id: dto.subject_id ?? question.subject_id,
        lesson_id: dto.lesson_id ?? question.lesson_id,
        chapter: dto.chapter ?? question.chapter,
        topic: dto.topic ?? question.topic,
        difficulty: dto.difficulty ?? question.difficulty,
        bloom_level: dto.bloom_level ?? question.bloom_level,
        content: nextContent,
        answer_key: nextAnswerKey,
        default_marks: dto.default_marks ?? question.default_marks,
        tags: dto.tags ?? question.tags,
      });

      if (contentChanged) {
        question.current_version += 1;
        await manager.save(
          QuestionVersion,
          manager.create(QuestionVersion, {
            question_id: question.id,
            version: question.current_version,
            type: question.type,
            content: question.content,
            answer_key: question.answer_key,
            default_marks: question.default_marks,
            created_by: teacherId,
          }),
        );
      }
      return manager.save(Question, question);
    });
  }

  /** A single owned question. */
  public async findOne(id: string, teacherId: string): Promise<Question> {
    return this.findOwned(id, teacherId);
  }

  /** Version history for an owned question (newest first). */
  public async getVersions(id: string, teacherId: string): Promise<QuestionVersion[]> {
    await this.findOwned(id, teacherId);
    return this.versions.find({ where: { question_id: id }, order: { version: 'DESC' } });
  }

  /** Soft-delete an owned question (exam snapshots keep working). */
  public async remove(id: string, teacherId: string): Promise<void> {
    await this.findOwned(id, teacherId);
    await this.questions.softDelete(id);
  }

  /** Paginated, filtered list of the teacher's questions. */
  public async findMany(
    teacherId: string,
    filter: QuestionFilterDto,
  ): Promise<PaginatedResponse<Question>> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const qb = this.questions
      .createQueryBuilder('q')
      .where('q.teacher_id = :teacherId', { teacherId })
      .andWhere('q.deleted_at IS NULL');

    if (filter.subject_id) qb.andWhere('q.subject_id = :s', { s: filter.subject_id });
    if (filter.lesson_id) qb.andWhere('q.lesson_id = :l', { l: filter.lesson_id });
    if (filter.type) qb.andWhere('q.type = :t', { t: filter.type });
    if (filter.difficulty) qb.andWhere('q.difficulty = :d', { d: filter.difficulty });
    if (filter.tag) qb.andWhere(':tag = ANY(q.tags)', { tag: filter.tag });
    if (filter.search !== undefined && filter.search !== '') {
      qb.andWhere(
        "(q.content->'prompt'->>'en' ILIKE :q OR q.content->'prompt'->>'ar' ILIKE :q)",
        { q: `%${filter.search}%` },
      );
    }

    qb.orderBy('q.created_at', 'DESC').skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, meta: this.meta(total, page, limit) };
  }

  // ---- helpers ----

  private async findOwned(id: string, teacherId: string): Promise<Question> {
    const question = await this.questions.findOne({ where: { id, deleted_at: IsNull() } });
    if (!question) throw new NotFoundException('Question not found');
    if (question.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only manage your own questions');
    }
    return question;
  }

  private validatePayload(
    type: QuestionType,
    content: Record<string, unknown>,
    answerKey: Record<string, unknown>,
  ): void {
    const errors = this.registry.require(type).validateAuthoring(content, answerKey);
    if (errors.length > 0) {
      throw new BadRequestException({ message: 'Invalid question payload', errors });
    }
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
