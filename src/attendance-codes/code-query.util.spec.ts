import { applyCodeSelection } from './code-query.util';
import { AttendanceCodeStatus } from './entities';

interface RecordedWhere {
  sql: string;
  params: Record<string, unknown> | undefined;
}

/** Minimal fake SelectQueryBuilder capturing andWhere clauses. */
function fakeQb(): {
  qb: any;
  clauses: RecordedWhere[];
} {
  const clauses: RecordedWhere[] = [];
  const qb: any = {
    andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
      clauses.push({ sql, params });
      return qb;
    }),
  };
  return { qb, clauses };
}

describe('applyCodeSelection', () => {
  it('adds no clauses for an empty selection', () => {
    const { qb, clauses } = fakeQb();
    applyCodeSelection(qb, {});
    expect(clauses).toHaveLength(0);
  });

  it('applies scalar filters with parameters', () => {
    const { qb, clauses } = fakeQb();
    applyCodeSelection(qb, {
      batch_id: 'b1',
      type: 'lesson',
      item_id: 'i1',
      created_by: 'c1',
      used_by: 'u1',
    });
    const sql = clauses.map((c) => c.sql).join(' | ');
    expect(sql).toContain('code.batch_id = :bid');
    expect(sql).toContain('code.type = :ty');
    expect(sql).toContain('code.item_id = :it');
    expect(sql).toContain('code.created_by = :cb');
    expect(sql).toContain('code.used_by = :ub');
  });

  it('uses ILIKE for search', () => {
    const { qb, clauses } = fakeQb();
    applyCodeSelection(qb, { search: 'abc' });
    expect(clauses[0]!.sql).toContain('ILIKE');
    expect(clauses[0]!.params).toEqual({ c: '%abc%' });
  });

  it('derives EXPIRED as unused + past expiry', () => {
    const { qb, clauses } = fakeQb();
    applyCodeSelection(qb, { status: AttendanceCodeStatus.EXPIRED });
    const sql = clauses.map((c) => c.sql);
    expect(sql.some((s) => s.includes('status = :unused'))).toBe(true);
    expect(sql.some((s) => s.includes('expires_at <= :now'))).toBe(true);
  });

  it('derives UNUSED as unused + not yet expired', () => {
    const { qb, clauses } = fakeQb();
    applyCodeSelection(qb, { status: AttendanceCodeStatus.UNUSED });
    const sql = clauses.map((c) => c.sql);
    expect(sql.some((s) => s.includes('status = :unused'))).toBe(true);
    expect(sql.some((s) => s.includes('expires_at > :now'))).toBe(true);
  });

  it('maps other statuses directly', () => {
    const { qb, clauses } = fakeQb();
    applyCodeSelection(qb, { status: AttendanceCodeStatus.REVOKED });
    expect(clauses.some((c) => c.sql.includes('code.status = :st'))).toBe(true);
    expect(
      clauses.some((c) => c.params && c.params['st'] === 'revoked'),
    ).toBe(true);
  });

  it('honours a custom alias', () => {
    const { qb, clauses } = fakeQb();
    applyCodeSelection(qb, { batch_id: 'b1' }, 'c');
    expect(clauses[0]!.sql).toContain('c.batch_id');
  });
});
