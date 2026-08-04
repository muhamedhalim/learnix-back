import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import { FinanceAuditFilterDto } from '../dto';

/** One `payment_audit_logs` row, joined to the admin who performed it. */
export interface FinanceAuditRow {
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  details: Record<string, unknown> | null;
  created_at: Date;
}

/**
 * Read-only, teacher-scoped view over `payment_audit_logs`.
 *
 * Financial services write one audit row inside the same transaction as every
 * mutation, but until now those rows were only readable embedded in a single
 * settlement's details. This exposes the whole trail for one teacher.
 *
 * `payment_audit_logs` has no `teacher_id` column — a row points at a
 * settlement, refund, order, or manual submission — so each resource type
 * resolves to a teacher through its own join. The set of joins is closed: a
 * record type with no teacher path is never returned, so this can never leak
 * another teacher's history or unattributed platform activity.
 *
 * Nothing here mutates state, so it deliberately runs outside a transaction and
 * takes no locks.
 */
@Injectable()
export class FinanceAuditService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Every audit row that resolves to this teacher, newest first.
   *
   * `IDX_payment_audit_resource (resource_type, resource_id)` covers each
   * branch of the union, so no new index is required.
   */
  public async list(
    filter: FinanceAuditFilterDto,
  ): Promise<{ data: FinanceAuditRow[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = Math.min(filter.limit ?? 20, 100);

    // $1 is the teacher. Every other parameter is appended positionally.
    const params: unknown[] = [filter.teacher_id];
    const conditions: string[] = [];

    if (filter.resource_type) {
      params.push(filter.resource_type);
      conditions.push(`scoped.resource_type = $${params.length}`);
    }
    if (filter.action) {
      params.push(filter.action);
      conditions.push(`scoped.action = $${params.length}`);
    }
    if (filter.from) {
      params.push(filter.from);
      conditions.push(`scoped.created_at >= $${params.length}`);
    }
    if (filter.to) {
      params.push(filter.to);
      conditions.push(`scoped.created_at < $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Each branch resolves `resource_id` to a teacher through the owning record.
    // Orders carry `teacher_id` directly; refunds and manual submissions reach
    // it through their order.
    const scoped = `
      SELECT log.*
        FROM payment_audit_logs log
        JOIN teacher_settlements settlement ON settlement.id = log.resource_id
       WHERE log.resource_type = 'settlement' AND settlement.teacher_id = $1
      UNION ALL
      SELECT log.*
        FROM payment_audit_logs log
        JOIN refunds refund ON refund.id = log.resource_id
        JOIN orders refund_order ON refund_order.id = refund.order_id
       WHERE log.resource_type = 'refund' AND refund_order.teacher_id = $1
      UNION ALL
      SELECT log.*
        FROM payment_audit_logs log
        JOIN orders sale ON sale.id = log.resource_id
       WHERE log.resource_type = 'order' AND sale.teacher_id = $1
      UNION ALL
      SELECT log.*
        FROM payment_audit_logs log
        JOIN manual_payment_submissions submission ON submission.id = log.resource_id
        JOIN orders submission_order ON submission_order.id = submission.order_id
       WHERE log.resource_type = 'manual_payment_submission'
         AND submission_order.teacher_id = $1
    `;

    const countRows = await this.dataSource.query<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM (${scoped}) scoped ${where}`,
      params,
    );
    const total = Number(countRows[0]?.count ?? 0);

    const paginated = [...params, limit, (page - 1) * limit];
    const data = await this.dataSource.query<FinanceAuditRow[]>(
      `SELECT scoped.id, scoped.actor_id, actor.name AS actor_name, actor.email AS actor_email,
              scoped.action, scoped.resource_type, scoped.resource_id, scoped.details,
              scoped.created_at
         FROM (${scoped}) scoped
         LEFT JOIN users actor ON actor.id = scoped.actor_id
         ${where}
        ORDER BY scoped.created_at DESC, scoped.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      paginated,
    );

    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /** Distinct actions present for this teacher, for the filter dropdown. */
  public async actions(teacherId: string): Promise<string[]> {
    const rows = await this.dataSource.query<Array<{ action: string }>>(
      `SELECT DISTINCT log.action
         FROM payment_audit_logs log
         LEFT JOIN teacher_settlements settlement
           ON settlement.id = log.resource_id AND log.resource_type = 'settlement'
         LEFT JOIN refunds refund
           ON refund.id = log.resource_id AND log.resource_type = 'refund'
         LEFT JOIN orders refund_order ON refund_order.id = refund.order_id
         LEFT JOIN orders sale
           ON sale.id = log.resource_id AND log.resource_type = 'order'
         LEFT JOIN manual_payment_submissions submission
           ON submission.id = log.resource_id
          AND log.resource_type = 'manual_payment_submission'
         LEFT JOIN orders submission_order ON submission_order.id = submission.order_id
        WHERE $1 IN (settlement.teacher_id, refund_order.teacher_id, sale.teacher_id,
                     submission_order.teacher_id)
        ORDER BY log.action ASC`,
      [teacherId],
    );
    return rows.map((row) => row.action);
  }
}
