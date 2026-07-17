import { NotFoundException } from '@nestjs/common';

import type { Repository, SelectQueryBuilder } from 'typeorm';

import { Exam } from '../entities';
import { ExamAccessService } from './exam-access.service';

function queryBuilder(result: Exam | null = null): {
  qb: SelectQueryBuilder<Exam>;
  where: jest.Mock;
  andWhere: jest.Mock;
  getOne: jest.Mock;
} {
  const where = jest.fn();
  const andWhere = jest.fn();
  const getOne = jest.fn().mockResolvedValue(result);
  const qb = { where, andWhere, getOne } as unknown as SelectQueryBuilder<Exam>;
  where.mockReturnValue(qb);
  andWhere.mockReturnValue(qb);
  return { qb, where, andWhere, getOne };
}

describe('ExamAccessService', () => {
  it('scopes lesson exams to active direct access or course enrolment', () => {
    const { qb, andWhere } = queryBuilder();
    const service = new ExamAccessService({} as Repository<Exam>);

    service.applyStudentScope(qb, 'student-1');

    const sql = andWhere.mock.calls.map((call: unknown[]) => String(call[0])).join(' ');
    expect(sql).toContain('lesson_purchases');
    expect(sql).toContain('lp.access_expires_at > :accessNow');
    expect(sql).toContain('package_purchases');
    expect(sql).toContain('lesson_package_items');
    expect(sql).toContain('lpi.lesson_id = exam.lesson_id');
  });

  it('scopes exams without a lesson to the instructor roster', () => {
    const { qb, andWhere } = queryBuilder();
    const service = new ExamAccessService({} as Repository<Exam>);

    service.applyStudentScope(qb, 'student-1');

    const sql = andWhere.mock.calls.map((call: unknown[]) => String(call[0])).join(' ');
    expect(sql).toContain('roster_lesson.teacher_id = exam.teacher_id');
    expect(sql).toContain('roster_lp.access_expires_at > :accessNow');
    expect(sql).toContain('roster_package.teacher_id = exam.teacher_id');
  });

  it('scopes course-targeted exams to an actual purchase of that course', () => {
    const { qb, andWhere } = queryBuilder();
    const service = new ExamAccessService({} as Repository<Exam>);

    service.applyStudentScope(qb, 'student-1');

    const sql = andWhere.mock.calls.map((call: unknown[]) => String(call[0])).join(' ');
    expect(sql).toContain('target_pp.package_id = exam.package_id');
  });

  it('allows public exams through the general attempt scope', () => {
    const { qb, andWhere } = queryBuilder();
    const service = new ExamAccessService({} as Repository<Exam>);

    service.applyAccessibleScope(qb, 'student-1');

    const sql = andWhere.mock.calls.map((call: unknown[]) => String(call[0])).join(' ');
    expect(sql).toContain('exam.is_public = true');
    expect(sql).toContain('exam.is_public = false');
  });

  it('always excludes public quizzes from private student exams', () => {
    const { qb, andWhere } = queryBuilder();
    const service = new ExamAccessService({} as Repository<Exam>);

    service.applyStudentScope(qb, 'student-1');

    expect(andWhere).toHaveBeenCalledWith('exam.is_public = false');
  });

  it('returns 404 without leaking an unaffiliated exam', async () => {
    const { qb } = queryBuilder(null);
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as Repository<Exam>;
    const service = new ExamAccessService(repository);

    await expect(
      service.findAccessiblePrivateExam('other-student', 'private-exam'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns an accessible exam without exposing authorization internals', async () => {
    const exam = { id: 'exam-1', is_public: false } as Exam;
    const { qb } = queryBuilder(exam);
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as Repository<Exam>;
    const service = new ExamAccessService(repository);

    await expect(service.findAccessiblePrivateExam('enrolled-student', exam.id)).resolves.toBe(
      exam,
    );
  });
});
