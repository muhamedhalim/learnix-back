import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T212 (FR-331, SC-013): `CatalogSearchService.applySearch()` runs
 * `ILIKE '%term%'` over title/summary/description in both languages —
 * without trigram support that is an unindexable sequential scan on every
 * keyword search, the one catalogue query shape the plain B-tree indexes in
 * `2094000000000-CreateMarketplaceCatalog` cannot help with at all.
 * `pg_trgm`'s GIN indexes are exactly what accelerates `ILIKE '%...%'`
 * (unlike a B-tree, which only helps a left-anchored `LIKE 'term%'`).
 * `gin_trgm_ops` is applied per column rather than to the exact folded,
 * concatenated expression `applySearch()` builds at query time, since a
 * functional index only ever matches a byte-identical expression and this
 * one is assembled dynamically — per-column indexes are what
 * `CatalogSearchService`'s own code comment already named as this task's
 * job, and they still let the planner bitmap-OR across title/summary/
 * description instead of a full scan. This is additive infrastructure,
 * not yet been proven against a 50k-row `EXPLAIN ANALYZE` (T212's load
 * test) — see tasks.md for that outstanding verification.
 */
export class AddMarketplaceCourseSearchTrigramIndexes2108000000000 implements MigrationInterface {
  public name = 'AddMarketplaceCourseSearchTrigramIndexes2108000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX IF NOT EXISTS "IDX_mp_courses_title_trgm"
        ON "marketplace_courses" USING gin ("title" gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS "IDX_mp_courses_title_ar_trgm"
        ON "marketplace_courses" USING gin ("title_ar" gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS "IDX_mp_courses_summary_trgm"
        ON "marketplace_courses" USING gin ("summary" gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS "IDX_mp_courses_description_trgm"
        ON "marketplace_courses" USING gin ("description" gin_trgm_ops);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_mp_courses_description_trgm";
      DROP INDEX IF EXISTS "IDX_mp_courses_summary_trgm";
      DROP INDEX IF EXISTS "IDX_mp_courses_title_ar_trgm";
      DROP INDEX IF EXISTS "IDX_mp_courses_title_trgm";
    `);
  }
}
