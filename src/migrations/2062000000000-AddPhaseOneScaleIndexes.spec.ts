import { AddPhaseOneScaleIndexes2062000000000 } from './2062000000000-AddPhaseOneScaleIndexes';

describe('AddPhaseOneScaleIndexes migration', () => {
  it('adds the Phase 1 filter indexes without changing stored data', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new AddPhaseOneScaleIndexes2062000000000().up({ query } as never);

    expect(query).toHaveBeenCalledTimes(3);
    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('IDX_student_profiles_grade_level');
    expect(sql).toContain('IDX_attendance_codes_created_by');
    expect(sql).toContain('IDX_attendance_codes_used_by');
    expect(sql).toContain('IF NOT EXISTS');
    expect(sql).not.toMatch(/DELETE|UPDATE|ALTER TABLE/);
  });

  it('removes only the indexes it owns on rollback', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new AddPhaseOneScaleIndexes2062000000000().down({ query } as never);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.map(([statement]) => String(statement)).join('\n')).toContain(
      'DROP INDEX IF EXISTS',
    );
  });
});
