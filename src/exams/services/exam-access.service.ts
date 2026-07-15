import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository, SelectQueryBuilder } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { Exam } from '../entities';

/**
 * Canonical student-to-exam audience policy.
 *
 * Lesson-linked exams are restricted to students with current direct lesson
 * access or a course/package enrolment containing that lesson. Exams without a
 * lesson use the existing instructor roster relationship (a purchase from that
 * instructor). Public practice content is deliberately excluded from this
 * private student-exam surface.
 */
@Injectable()
export class ExamAccessService {
  constructor(@InjectRepository(Exam) private readonly exams: Repository<Exam>) {}

  public applyStudentScope(
    qb: SelectQueryBuilder<Exam>,
    studentId: string,
    alias = 'exam',
  ): SelectQueryBuilder<Exam> {
    const directLessonAccess = `EXISTS (
      SELECT 1 FROM lesson_purchases lp
      WHERE lp.student_id = :studentId
        AND lp.lesson_id = ${alias}.lesson_id
        AND lp.access_expires_at > :accessNow
    )`;
    const courseLessonAccess = `EXISTS (
      SELECT 1 FROM package_purchases pp
      INNER JOIN lesson_package_items lpi ON lpi.package_id = pp.package_id
      WHERE pp.student_id = :studentId
        AND lpi.lesson_id = ${alias}.lesson_id
    )`;
    const instructorRosterAccess = `EXISTS (
      SELECT 1 FROM lesson_purchases roster_lp
      INNER JOIN lessons roster_lesson ON roster_lesson.id = roster_lp.lesson_id
      WHERE roster_lp.student_id = :studentId
        AND roster_lesson.teacher_id = ${alias}.teacher_id
    ) OR EXISTS (
      SELECT 1 FROM package_purchases roster_pp
      INNER JOIN lesson_packages roster_package ON roster_package.id = roster_pp.package_id
      WHERE roster_pp.student_id = :studentId
        AND roster_package.teacher_id = ${alias}.teacher_id
    )`;

    return qb.andWhere(`${alias}.is_public = false`).andWhere(
      `((${alias}.lesson_id IS NOT NULL AND (${directLessonAccess} OR ${courseLessonAccess}))
          OR (${alias}.lesson_id IS NULL AND (${instructorRosterAccess})))`,
      { studentId, accessNow: new Date() },
    );
  }

  /** Returns 404 rather than revealing whether an out-of-scope exam exists. */
  public async findAccessiblePrivateExam(studentId: string, examId: string): Promise<Exam> {
    const qb = this.exams
      .createQueryBuilder('exam')
      .where('exam.id = :examId', { examId })
      .andWhere('exam.deleted_at IS NULL');
    this.applyStudentScope(qb, studentId);
    const exam = await qb.getOne();
    if (!exam) {
      throw new NotFoundException(biBody('Exam not found', 'الاختبار غير موجود'));
    }
    return exam;
  }

  public async assertCanAccessPrivateExam(studentId: string, examId: string): Promise<void> {
    await this.findAccessiblePrivateExam(studentId, examId);
  }
}
