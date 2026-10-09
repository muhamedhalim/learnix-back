import { examAudienceStudentIds } from '../../payments/lesson-audience';

const NOW = new Date('2026-01-01T00:00:00Z');

function runner(rows: Array<{ student_id: string }>[]) {
  const query = jest.fn();
  for (const r of rows) query.mockResolvedValueOnce(r);
  return { query };
}

const base = { is_public: false, lesson_id: null, package_id: null, teacher_id: 't1' };

describe('examAudienceStudentIds (T075 / W4-C10)', () => {
  it('public exam: nobody, no query', async () => {
    const r = runner([]);
    await expect(
      examAudienceStudentIds(r, { ...base, is_public: true, lesson_id: 'l1' }, NOW),
    ).resolves.toEqual([]);
    expect(r.query).not.toHaveBeenCalled();
  });

  it('lesson exam: one direct-purchase query bound to the lesson and the clock, no package branch', async () => {
    const r = runner([[{ student_id: 's1' }]]);
    await expect(examAudienceStudentIds(r, { ...base, lesson_id: 'l1' }, NOW)).resolves.toEqual([
      's1',
    ]);
    expect(r.query).toHaveBeenCalledTimes(1);
    const [sql, params] = r.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('lesson_purchases');
    expect(sql).not.toContain('package_purchases');
    expect(sql).toContain('revoked_at IS NULL');
    expect(sql).toContain('access_expires_at > $2');
    expect(params).toEqual(['l1', NOW]);
  });

  it('package exam: unrevoked package purchases only', async () => {
    const r = runner([[{ student_id: 's2' }]]);
    await expect(examAudienceStudentIds(r, { ...base, package_id: 'p1' }, NOW)).resolves.toEqual([
      's2',
    ]);
    const [sql, params] = r.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('package_purchases');
    expect(sql).not.toContain('lesson_purchases');
    expect(sql).toContain('revoked_at IS NULL');
    expect(params).toEqual(['p1']);
  });

  it('unscoped exam: one roster query over the teacher, deduplicated', async () => {
    const r = runner([[{ student_id: 's1' }, { student_id: 's1' }, { student_id: 's3' }]]);
    await expect(examAudienceStudentIds(r, base, NOW)).resolves.toEqual(['s1', 's3']);
    expect(r.query).toHaveBeenCalledTimes(1);
    expect((r.query.mock.calls[0] as [string, unknown[]])[1]).toEqual(['t1', NOW]);
  });
});
