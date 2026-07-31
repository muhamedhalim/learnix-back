import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AuditLog } from '../activity-logs/entities/audit-log.entity';
import { biBody } from '../i18n/error-translator.util';
import { User } from './entities/user.entity';
import { UserRole } from './entities/user-role.enum';

type AccountKind = UserRole.TEACHER | UserRole.STUDENT;
type ForeignKey = { tableName: string; columnName: string };
type FinancialRecord = { table: string; count: number };
type DeletionPreview = {
  id: string;
  name: string;
  email: string;
  role: AccountKind;
  records: Array<{ table: string; count: number }>;
  financial_records: FinancialRecord[];
  deletion_blocked: boolean;
};

/**
 * Explicit, schema-driven account erasure. It walks the live PostgreSQL foreign
 * key graph and deletes child rows before their parent rather than relying on
 * TypeORM or database CASCADE. This deliberately covers newly-added dependent
 * tables without allowing a forgotten FK to leave an orphan.
 */
@Injectable()
export class AccountDeletionService {
  private readonly tableHasId = new Map<string, boolean>();
  constructor(private readonly dataSource: DataSource) {}

  public async preview(
    targetId: string,
    expectedRole: AccountKind,
    actorId: string,
  ): Promise<DeletionPreview> {
    const target = await this.getTarget(targetId, expectedRole, actorId);
    const counts = new Map<string, number>();
    await this.collectDescendants(this.dataSource.manager, 'users', [target.id], counts, new Set());
    const financialRecords = await this.financialHistory(this.dataSource.manager, target.id);
    return {
      id: target.id,
      name: target.name,
      email: target.email,
      role: target.role as AccountKind,
      records: [...counts]
        .filter(([, count]) => count > 0)
        .map(([table, count]) => ({ table, count }))
        .sort((a, b) => a.table.localeCompare(b.table)),
      financial_records: financialRecords,
      deletion_blocked: financialRecords.length > 0,
    };
  }

  public async permanentlyDelete(
    targetId: string,
    expectedRole: AccountKind,
    actorId: string,
    reason?: string,
  ): Promise<{
    deleted: boolean;
    alreadyDeleted: boolean;
    records: Array<{ table: string; count: number }>;
  }> {
    if (targetId === actorId) {
      throw new ForbiddenException(
        biBody('You cannot delete your own account', 'لا يمكنك حذف حسابك الحالي'),
      );
    }
    return await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<Array<Pick<User, 'id' | 'name' | 'email' | 'role'>>>(
        'SELECT id, name, email, role FROM users WHERE id = $1 FOR UPDATE',
        [targetId],
      );
      const target = rows[0];
      // Repeated DELETE requests are safe after the first committed transaction.
      if (!target) return { deleted: true, alreadyDeleted: true, records: [] };
      this.assertTarget(target, expectedRole, actorId);

      const financialRecords = await this.financialHistory(manager, target.id);
      if (financialRecords.length > 0) {
        throw new ConflictException({
          code: 'ACCOUNT_DELETE_FINANCIAL_RECORDS_RETAINED',
          message:
            'Accounts with financial history must be archived or anonymized; orders, payments, refunds, ledger entries, and settlements are retained.',
          financial_records: financialRecords,
        });
      }

      const counts = new Map<string, number>();
      await this.deleteDescendants(manager, 'users', [target.id], counts, new Set());
      // Audit rows that identify the target are target data. The deletion event
      // below is deliberately retained under the acting administrator instead.
      await manager.query(
        "DELETE FROM audit_logs WHERE target_id = $1 AND target_type IN ('teacher', 'student', 'user')",
        [target.id],
      );
      // TypeORM's PostgreSQL driver returns DELETE results as [rows, rowCount]
      // even with RETURNING. Checking the outer array length incorrectly turns a
      // successful one-row deletion into a 409 because its length is always 2.
      const [, deletedUserCount] = await manager.query<[Array<{ id: string }>, number]>(
        'DELETE FROM users WHERE id = $1 RETURNING id',
        [target.id],
      );
      if (deletedUserCount !== 1)
        throw new ConflictException({
          code: 'ACCOUNT_DELETE_DEPENDENCY_CONFLICT',
          message: 'Account deletion could not be completed',
        });
      await manager.getRepository(AuditLog).save({
        admin_id: actorId,
        action: 'account.permanently_deleted',
        target_type: expectedRole,
        target_id: target.id,
        target_name: target.name,
        details: { reason: reason ?? null, deletedEmail: target.email, records: [...counts] },
      });
      return {
        deleted: true,
        alreadyDeleted: false,
        records: [...counts].map(([table, count]) => ({ table, count })),
      };
    });
  }

  private async getTarget(
    targetId: string,
    expectedRole: AccountKind,
    actorId: string,
  ): Promise<User> {
    if (targetId === actorId)
      throw new ForbiddenException(
        biBody('You cannot delete your own account', 'لا يمكنك حذف حسابك الحالي'),
      );
    const target = await this.dataSource.getRepository(User).findOne({ where: { id: targetId } });
    if (!target) throw new NotFoundException(biBody('Account not found', 'الحساب غير موجود'));
    this.assertTarget(target, expectedRole, actorId);
    return target;
  }

  /**
   * Financial records are append-only legal/accounting evidence.  This guard
   * runs before the generic FK-graph delete walker, which otherwise could
   * manually delete rows even when their database FKs are RESTRICT.
   */
  private async financialHistory(
    manager: EntityManager,
    userId: string,
  ): Promise<FinancialRecord[]> {
    const rows = await manager.query<Array<FinancialRecord>>(
      `
        SELECT 'orders' AS table, COUNT(*)::int AS count
        FROM orders WHERE teacher_id = $1 OR student_id = $1
        UNION ALL
        SELECT 'payments' AS table, COUNT(*)::int AS count
        FROM payments WHERE user_id = $1
        UNION ALL
        SELECT 'financial_ledger_entries' AS table, COUNT(*)::int AS count
        FROM financial_ledger_entries WHERE teacher_id = $1
        UNION ALL
        SELECT 'teacher_settlements' AS table, COUNT(*)::int AS count
        FROM teacher_settlements WHERE teacher_id = $1
      `,
      [userId],
    );
    return rows
      .map((row) => ({ table: row.table, count: Number(row.count) }))
      .filter((row) => row.count > 0);
  }

  private assertTarget(
    target: Pick<User, 'id' | 'role'>,
    expectedRole: AccountKind,
    actorId: string,
  ): void {
    if (target.id === actorId)
      throw new ForbiddenException(
        biBody('You cannot delete your own account', 'لا يمكنك حذف حسابك الحالي'),
      );
    if (target.role === UserRole.ADMIN || target.role !== expectedRole) {
      throw new ForbiddenException(
        biBody(
          'This account cannot be deleted from this endpoint',
          'لا يمكن حذف هذا الحساب من هذه الواجهة',
        ),
      );
    }
  }

  private async collectDescendants(
    manager: EntityManager,
    parentTable: string,
    parentIds: string[],
    counts: Map<string, number>,
    seen: Set<string>,
  ): Promise<void> {
    for (const fk of await this.findReferencingForeignKeys(manager, parentTable)) {
      if (!(await this.hasIdColumn(manager, fk.tableName))) {
        const count = await this.countRows(manager, fk, parentIds);
        if (count) counts.set(fk.tableName, (counts.get(fk.tableName) ?? 0) + count);
        continue;
      }
      const childIds = await this.findIds(manager, fk, parentIds);
      if (!childIds.length) continue;
      counts.set(fk.tableName, (counts.get(fk.tableName) ?? 0) + childIds.length);
      const key = `${fk.tableName}:${childIds.sort().join(',')}`;
      if (!seen.has(key)) {
        seen.add(key);
        await this.collectDescendants(manager, fk.tableName, childIds, counts, seen);
      }
    }
  }

  private async deleteDescendants(
    manager: EntityManager,
    parentTable: string,
    parentIds: string[],
    counts: Map<string, number>,
    seen: Set<string>,
  ): Promise<void> {
    for (const fk of await this.findReferencingForeignKeys(manager, parentTable)) {
      if (await this.hasIdColumn(manager, fk.tableName)) {
        const childIds = await this.findIds(manager, fk, parentIds);
        if (childIds.length) {
          const key = `${fk.tableName}:${childIds.sort().join(',')}`;
          if (!seen.has(key)) {
            seen.add(key);
            await this.deleteDescendants(manager, fk.tableName, childIds, counts, seen);
          }
        }
      }
      const hasId = await this.hasIdColumn(manager, fk.tableName);
      const count = hasId
        ? (
            await manager.query<[Array<{ id: string }>, number]>(
              `DELETE FROM ${this.identifier(fk.tableName)} WHERE ${this.identifier(fk.columnName)} = ANY($1) RETURNING id`,
              [parentIds],
            )
          )[1]
        : await this.countRows(manager, fk, parentIds);
      if (!hasId)
        await manager.query(
          `DELETE FROM ${this.identifier(fk.tableName)} WHERE ${this.identifier(fk.columnName)} = ANY($1)`,
          [parentIds],
        );
      if (count) counts.set(fk.tableName, (counts.get(fk.tableName) ?? 0) + count);
    }
  }

  private async findReferencingForeignKeys(
    manager: EntityManager,
    parentTable: string,
  ): Promise<ForeignKey[]> {
    return await manager.query<ForeignKey[]>(
      `SELECT tc.table_name AS "tableName", kcu.column_name AS "columnName"
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
         AND ccu.table_name = $1 AND ccu.column_name = 'id'`,
      [parentTable],
    );
  }

  private async findIds(
    manager: EntityManager,
    fk: ForeignKey,
    parentIds: string[],
  ): Promise<string[]> {
    const rows = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM ${this.identifier(fk.tableName)} WHERE ${this.identifier(fk.columnName)} = ANY($1)`,
      [parentIds],
    );
    return rows.map((row) => row.id);
  }

  private async countRows(
    manager: EntityManager,
    fk: ForeignKey,
    parentIds: string[],
  ): Promise<number> {
    const rows = await manager.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::int AS count FROM ${this.identifier(fk.tableName)} WHERE ${this.identifier(fk.columnName)} = ANY($1)`,
      [parentIds],
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async hasIdColumn(manager: EntityManager, tableName: string): Promise<boolean> {
    const cached = this.tableHasId.get(tableName);
    if (cached !== undefined) return cached;
    const rows = await manager.query<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'
      ) AS exists`,
      [tableName],
    );
    const exists = Boolean(rows[0]?.exists);
    this.tableHasId.set(tableName, exists);
    return exists;
  }

  private identifier(value: string): string {
    if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('Unexpected database identifier');
    return `"${value}"`;
  }
}
