import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { PaginatedResponse, PaginationMeta } from '../../common/interfaces/pagination.interface';
import { ExamFilterDto } from '../dto';
import { Exam, ExamStatus } from '../entities';
import { ExamAccessService } from './exam-access.service';

/**
 * The student's exam catalogue: the exams scoped to them and the public question bank. Moved
 * unchanged out of `StudentExamsController` (the list projection is the one both endpoints already
 * shared field for field).
 */
@Injectable()
export class StudentExamCatalogService {
  constructor(
    @InjectRepository(Exam) private readonly exams: Repository<Exam>,
    private readonly access: ExamAccessService,
  ) {}

  public async listForStudent(
    studentId: string,
    filter: ExamFilterDto,
  ): Promise<PaginatedResponse<unknown>> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const qb = this.exams
      .createQueryBuilder('exam')
      .leftJoinAndSelect('exam.subject', 'subject')
      .leftJoinAndSelect('exam.teacher', 'teacher')
      .where('exam.deleted_at IS NULL')
      .andWhere('exam.status IN (:...statuses)', {
        statuses: [ExamStatus.PUBLISHED, ExamStatus.SCHEDULED],
      });
    this.access.applyStudentScope(qb, studentId);
    if (filter.subject_id) qb.andWhere('exam.subject_id = :s', { s: filter.subject_id });
    if (filter.search)
      qb.andWhere('(exam.title ILIKE :q OR exam.title_ar ILIKE :q)', { q: `%${filter.search}%` });
    qb.orderBy('exam.created_at', 'DESC')
      .addOrderBy('exam.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const data = rows.map((exam) => this.toListItem(exam));
    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
    return { data, meta };
  }

  public async listQuestionBank(filter: ExamFilterDto): Promise<PaginatedResponse<unknown>> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const qb = this.exams
      .createQueryBuilder('exam')
      .leftJoinAndSelect('exam.subject', 'subject')
      .leftJoinAndSelect('exam.teacher', 'teacher')
      .where('exam.deleted_at IS NULL')
      .andWhere('exam.is_public = true')
      .andWhere('exam.status IN (:...statuses)', {
        statuses: [ExamStatus.PUBLISHED, ExamStatus.SCHEDULED],
      });
    if (filter.subject_id) qb.andWhere('exam.subject_id = :s', { s: filter.subject_id });
    if (filter.search) {
      qb.andWhere('(exam.title ILIKE :q OR exam.title_ar ILIKE :q)', {
        q: `%${filter.search}%`,
      });
    }
    qb.orderBy('exam.created_at', 'DESC')
      .addOrderBy('exam.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const data = rows.map((exam) => this.toListItem(exam));
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  private toListItem(exam: Exam): Record<string, unknown> {
    return {
      id: exam.id,
      title: exam.title,
      title_ar: exam.title_ar,
      description: exam.description,
      description_ar: exam.description_ar,
      subject: exam.subject ? { id: exam.subject.id, name: exam.subject.name } : null,
      teacher: exam.teacher ? { id: exam.teacher.id, name: exam.teacher.name } : null,
      total_marks: exam.total_marks,
      passing_marks: exam.passing_marks,
      duration_seconds: exam.config.duration_seconds,
      attempts_allowed: exam.config.attempts_allowed,
      start_window_at: exam.config.start_window_at ?? null,
      end_window_at: exam.config.end_window_at ?? null,
      status: exam.status,
      is_public: exam.is_public,
    };
  }
}
