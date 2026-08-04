import { SubjectStatus } from './entities/subject-status.enum';
import { usableSubjectByIdWhere, usableSubjectWhere } from './subject-visibility.util';

describe('usableSubjectWhere', () => {
  it('allows the approved catalogue plus the teacher\'s own pending submissions', () => {
    const clauses = usableSubjectWhere('teacher-a');

    expect(clauses).toHaveLength(2);
    expect(clauses[0]).toMatchObject({ status: SubjectStatus.APPROVED });
    expect(clauses[1]).toMatchObject({
      status: SubjectStatus.PENDING_APPROVAL,
      created_by_teacher_id: 'teacher-a',
    });
  });

  it('excludes soft-deleted rows from both branches', () => {
    for (const clause of usableSubjectWhere('teacher-a')) {
      expect(clause.deleted_at).toBeDefined();
    }
  });

  it('never matches another teacher\'s pending subject', () => {
    const clauses = usableSubjectWhere('teacher-a');
    const pending = clauses.find((c) => c.status === SubjectStatus.PENDING_APPROVAL);

    expect(pending?.created_by_teacher_id).toBe('teacher-a');
  });

  it('excludes the teacher\'s own rejected and suspended subjects', () => {
    const statuses = usableSubjectWhere('teacher-a').map((c) => c.status);

    expect(statuses).not.toContain(SubjectStatus.REJECTED);
    expect(statuses).not.toContain(SubjectStatus.SUSPENDED);
  });
});

describe('usableSubjectByIdWhere', () => {
  it('pins every branch to the requested id', () => {
    const clauses = usableSubjectByIdWhere('subject-1', 'teacher-a');

    expect(clauses).toHaveLength(2);
    for (const clause of clauses) {
      expect(clause.id).toBe('subject-1');
    }
  });
});
