import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DEF-008 — attendance export completeness.
 *
 * The export now walks the full filtered result set with KEYSET pagination on
 * the canonical admin ordering `(marked_at DESC, id DESC)`, asking for
 * `(marked_at, id) < (cursor_marked_at, cursor_id)` once per chunk. The
 * pre-existing single-column `IDX_attendance_marked_at` can seek on
 * `marked_at` but must then re-check `id` per candidate row; a composite index
 * in exactly the cursor's column order and direction lets Postgres seek
 * straight to the chunk boundary, so the cost of reaching chunk N stays flat
 * instead of growing with N.
 *
 * Created ASC/ASC (matching the entity's `@Index` declaration, so a
 * `synchronize`-built schema and a migrated one are identical): Postgres scans
 * a b-tree backwards just as cheaply, so one index serves both directions.
 *
 * Purely additive: a new index, no data change, no column change.
 */
export class AddAttendanceExportKeysetIndex2084000000000 implements MigrationInterface {
  public name = 'AddAttendanceExportKeysetIndex2084000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_attendance_records_marked_at_id"
        ON "attendance_records" ("marked_at", "id")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_attendance_records_marked_at_id"`);
  }
}
