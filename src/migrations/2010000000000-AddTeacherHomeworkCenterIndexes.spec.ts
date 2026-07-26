import { AddTeacherHomeworkCenterIndexes2010000000000 } from './2010000000000-AddTeacherHomeworkCenterIndexes';

describe('AddTeacherHomeworkCenterIndexes migration', () => {
  it('adds only teacher-homework query indexes and is safe to apply to existing data', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new AddTeacherHomeworkCenterIndexes2010000000000().up({ query } as never);

    expect(query).toHaveBeenCalledTimes(5);
    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('IDX_lesson_homework_lesson_published_due');
    expect(sql).toContain('IDX_lesson_homework_title_trgm');
    expect(sql).toContain('IDX_lesson_homework_title_ar_trgm');
    expect(sql).toContain('IDX_homework_submissions_homework_status_submitted');
    expect(sql).toContain('IDX_homework_submissions_homework_graded');
    expect(sql).toContain('IF NOT EXISTS');
    expect(sql).not.toMatch(/DELETE|UPDATE|ALTER TABLE/);
  });
});
