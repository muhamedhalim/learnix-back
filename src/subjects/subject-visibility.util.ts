import { IsNull } from 'typeorm';
import type { FindOptionsWhere, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { SubjectStatus } from './entities/subject-status.enum';
import type { Subject } from './entities/subject.entity';

/**
 * Which subjects a given teacher may attach to their own content: every
 * approved subject in the shared catalogue, plus their own still-pending
 * submission so they aren't blocked waiting on an admin.
 *
 * Deliberately excludes the teacher's own `rejected` subjects (they must be
 * edited and re-submitted first) and `suspended` ones (an admin kill-switch
 * that should hold even for the owner).
 *
 * A plain function rather than an injectable service: the lessons, packages,
 * books and exams modules all need this predicate, and a shared provider would
 * add module-graph edges (and cycle risk) for what is one WHERE clause.
 */
export function usableSubjectWhere(teacherId: string): FindOptionsWhere<Subject>[] {
  return [
    { deleted_at: IsNull(), status: SubjectStatus.APPROVED },
    {
      deleted_at: IsNull(),
      status: SubjectStatus.PENDING_APPROVAL,
      created_by_teacher_id: teacherId,
    },
  ];
}

/**
 * {@link usableSubjectWhere} narrowed to a single id — the shape most callers
 * want, since they are validating one `subject_id` off a DTO.
 */
export function usableSubjectByIdWhere(
  subjectId: string,
  teacherId: string,
): FindOptionsWhere<Subject>[] {
  return usableSubjectWhere(teacherId).map((clause) => ({ ...clause, id: subjectId }));
}

/**
 * QueryBuilder twin of {@link usableSubjectWhere}, for call sites that build a
 * query rather than a `findOne`. `alias` is the subject alias in the builder.
 */
export function applyUsableSubjectFilter<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  alias: string,
  teacherId: string,
): SelectQueryBuilder<T> {
  return qb.andWhere(
    `(${alias}.status = :usableApproved
      OR (${alias}.status = :usablePending AND ${alias}.created_by_teacher_id = :usableTeacherId))`,
    {
      usableApproved: SubjectStatus.APPROVED,
      usablePending: SubjectStatus.PENDING_APPROVAL,
      usableTeacherId: teacherId,
    },
  );
}
