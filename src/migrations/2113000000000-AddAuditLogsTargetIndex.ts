import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `audit_logs (target_type, target_id, created_at)` (spec 004 T113, C-008, gate W7-C3).
 *
 * `GET /admin/audit-log?target_type=…&target_id=…` (T112) filters on the target and orders by
 * `created_at DESC`. Only single-column indexes existed, so the planner scanned the whole table and
 * sorted the survivors. Synthetic measurement on 600 000 rows (see `gates/W7-C3.md`): parallel seq
 * scan, 8 786 buffers, 26 ms before; backward index scan, 34 buffers, 0.13 ms after. The table is
 * append-only and low-write, so the maintenance cost is negligible.
 *
 * Ascending columns on purpose: an ascending index serves `ORDER BY created_at DESC` with a
 * backward scan, and TypeORM's `@Index` cannot declare a descending column, so the entity
 * decorator can carry the identical name and columns. CONCURRENTLY, hence `transaction = false`.
 */
export class AddAuditLogsTargetIndex2113000000000 implements MigrationInterface {
  public name = 'AddAuditLogsTargetIndex2113000000000';

  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_audit_logs_target_created" ON "audit_logs" ("target_type", "target_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_audit_logs_target_created"`);
  }
}
