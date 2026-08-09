import { RemoveGradeLevel2071000000000 } from './2071000000000-RemoveGradeLevel';

describe('RemoveGradeLevel2071000000000', () => {
  it('removes only the obsolete Grade Level indexes and owned columns', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new RemoveGradeLevel2071000000000();

    await migration.up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('IDX_student_profiles_grade_level');
    expect(sql).toContain('IDX_subjects_grade_level');
    expect(sql).toContain('student_profiles" DROP COLUMN IF EXISTS "grade_level');
    expect(sql).toContain('subjects" DROP COLUMN IF EXISTS "grade_level');
    expect(sql).not.toMatch(/\b(?:DELETE|UPDATE|TRUNCATE)\b/);
  });

  it('restores the prior columns and indexes for a rollback', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new RemoveGradeLevel2071000000000();

    await migration.down({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "grade_level"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "IDX_student_profiles_grade_level"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "IDX_subjects_grade_level"');
  });
});
