import { SelectQueryBuilder } from 'typeorm';

import { AttendanceCode, AttendanceCodeStatus } from './entities';

/** Structural filter contract (satisfied by CodeSelectionDto/ListCodesQueryDto). */
export interface CodeSelection {
  search?: string | undefined;
  batch_id?: string | undefined;
  status?: AttendanceCodeStatus | undefined;
  type?: string | undefined;
  item_id?: string | undefined;
  created_by?: string | undefined;
  used_by?: string | undefined;
  from_date?: string | undefined;
  to_date?: string | undefined;
}

/**
 * Apply the shared admin code filters to a query builder. Single source of truth
 * for selection semantics so the codes table, exports and analytics stay
 * consistent. `expired` is derived (unused + past expiry); `unused` excludes
 * expired so the two statuses never overlap.
 */
export function applyCodeSelection(
  qb: SelectQueryBuilder<AttendanceCode>,
  sel: CodeSelection,
  alias = 'code',
): SelectQueryBuilder<AttendanceCode> {
  if (sel.search) {
    qb.andWhere(`${alias}.code ILIKE :c`, { c: `%${sel.search}%` });
  }
  if (sel.batch_id) qb.andWhere(`${alias}.batch_id = :bid`, { bid: sel.batch_id });
  if (sel.type) qb.andWhere(`${alias}.type = :ty`, { ty: sel.type });
  if (sel.item_id) qb.andWhere(`${alias}.item_id = :it`, { it: sel.item_id });
  if (sel.created_by) {
    qb.andWhere(`${alias}.created_by = :cb`, { cb: sel.created_by });
  }
  if (sel.used_by) qb.andWhere(`${alias}.used_by = :ub`, { ub: sel.used_by });
  if (sel.from_date) {
    qb.andWhere(`${alias}.created_at >= :fd`, { fd: sel.from_date });
  }
  if (sel.to_date) {
    qb.andWhere(`${alias}.created_at <= :td`, { td: sel.to_date });
  }

  const now = new Date();
  if (sel.status === AttendanceCodeStatus.EXPIRED) {
    qb.andWhere(`${alias}.status = :unused`, {
      unused: AttendanceCodeStatus.UNUSED,
    }).andWhere(`${alias}.expires_at <= :now`, { now });
  } else if (sel.status === AttendanceCodeStatus.UNUSED) {
    qb.andWhere(`${alias}.status = :unused`, {
      unused: AttendanceCodeStatus.UNUSED,
    }).andWhere(`${alias}.expires_at > :now`, { now });
  } else if (sel.status) {
    qb.andWhere(`${alias}.status = :st`, { st: sel.status });
  }

  return qb;
}

/** Re-export for callers that only need the entity type alongside the helper. */
export type { AttendanceCode };
